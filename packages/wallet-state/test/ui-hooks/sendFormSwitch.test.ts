import { createElement, type ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  P2MR_LEAF_VERSION_V1,
  bytesToHex,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import { KeyringType } from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'

import { createAppStore } from '../../src'
import { I18nContext } from '../../src/context/I18nContext'
import { accountActions } from '../../src/reducers/accounts'
import { settingsActions } from '../../src/reducers/settings'
import { initialState } from '../../src/reducers/ui'
import { useFeeRateBarLogic } from '../../src/ui-hooks/useFeeRateBarLogic'
import { useQbitConsolidationScreenLogic } from '../../src/ui-hooks/useQbitConsolidationScreenLogic'
import { useTxCreateScreenLogic } from '../../src/ui-hooks/useTxCreateScreenLogic'
import { createHookTestHarness, createWalletMock } from './testHelpers'

type Store = ReturnType<typeof createAppStore>

const NETWORKS = {
  [ChainType.QBIT_MAINNET]: 'mainnet',
  [ChainType.QBIT_TESTNET4]: 'testnet4',
  [ChainType.QBIT_REGTEST]: 'regtest',
} as const

/** A single-key P2MR account of `pubkeyHex` on `chainType`. */
function p2mrAccount(pubkeyHex: string, chainType: ChainType) {
  const pubkey = hexToBytes(pubkeyHex)
  const leafScript = singleKeyLeafScript(pubkey)
  const scriptPubKey = p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript))
  return {
    type: KeyringType.QbitHdKeyring,
    address: p2mrAddressFromPubkey(pubkey, NETWORKS[chainType]),
    pubkey: pubkeyHex,
    key: `account-${pubkeyHex.slice(0, 2)}`,
    flag: 0,
    p2mr: {
      pubkey: pubkeyHex,
      path: "m/87'/0'/0'/0/0",
      scriptPubKey: bytesToHex(scriptPubKey),
      leafScript: bytesToHex(leafScript),
      addresses: {
        mainnet: p2mrAddressFromPubkey(pubkey, 'mainnet'),
        testnet4: p2mrAddressFromPubkey(pubkey, 'testnet4'),
        signet: p2mrAddressFromPubkey(pubkey, 'signet'),
        regtest: p2mrAddressFromPubkey(pubkey, 'regtest'),
      },
      hkdf: { account: 0, change: 0, index: 0 },
      signatureCounter: {
        count: 0,
        limit: 1073741824,
        remaining: 1073741824,
        state: 'normal' as const,
        provenance: 'local' as const,
      },
    },
  }
}

type Account = ReturnType<typeof p2mrAccount>

const FIRST = p2mrAccount('11'.repeat(32), ChainType.QBIT_MAINNET)
const SECOND = p2mrAccount('22'.repeat(32), ChainType.QBIT_MAINNET)
const FIRST_ON_TESTNET = p2mrAccount('11'.repeat(32), ChainType.QBIT_TESTNET4)

const recipientOn = (chainType: ChainType) =>
  p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), NETWORKS[chainType])

const QUOTE = {
  list: [
    { title: 'Slow', desc: '', feeRate: 1 },
    { title: 'Normal', desc: '', feeRate: 2 },
    { title: 'Fast', desc: '', feeRate: 3 },
  ],
  quote: { source: 'esplora', availability: 'available', freshness: 'live' },
}
const AVG = 1
const CUSTOM = 3

const t = (key: string, substitutions?: string | string[] | Record<string, string | number>) =>
  Array.isArray(substitutions) ? `${key}:${substitutions.join(',')}` : key

/** Outputs of 0.1 QBT for `account`. */
const outputsOf = (account: Account) => [
  {
    txid: account.pubkey.slice(0, 2).repeat(32),
    vout: 0,
    satoshis: 10_000_000,
    scriptPk: account.p2mr.scriptPubKey,
    pubkey: account.pubkey,
    addressType: AddressType.P2MR,
  },
]

/**
 * The page's store with `account` selected on `chainType`, and a background
 * that reads the outputs, the balance and the consolidation status of
 * whichever account the store selects when asked.
 */
function setup(account: Account = FIRST, chainType = ChainType.QBIT_MAINNET) {
  const store: Store = createAppStore()
  const saved = { enableRBF: true }
  const selected = () => store.getState().accounts.current as unknown as Account
  const wallet = {
    ...createWalletMock(),
    getEnableRBF: vi.fn(async () => saved.enableRBF),
    setEnableRBF: vi.fn(async (enableRBF: boolean) => {
      saved.enableRBF = enableRBF
    }),
    getFeeSummary: vi.fn(async () => QUOTE),
    getLowFeeSummary: vi.fn(async () => QUOTE),
    getQbitUtxoSnapshot: vi.fn(async () => ({
      address: selected().address,
      chain: store.getState().settings.chainType,
      utxos: outputsOf(selected()),
    })),
    getQbitConsolidationStatus: vi.fn(async () => ({
      chain: store.getState().settings.chainType,
      address: selected().address,
      confirmedUnspent: 812,
      pendingSpent: 0,
      pendingFunded: 0,
      overLimit: true,
      outputLimit: 500,
      maxInputCount: 106,
      batchShape: { outputScriptLengths: [34], leafScriptLength: 34, controlBlockLength: 1 },
    })),
    createQbitConsolidationPsbt: vi.fn(),
  }
  const {
    wrapper: baseWrapper,
    navigation,
    tools,
  } = createHookTestHarness({ wallet: wallet as any, store })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      I18nContext.Provider,
      {
        value: {
          t,
          locale: 'en',
          supportedLocales: [],
          localeNames: {},
          changeLocale: async () => {},
          isSpecialLocale: false,
        } as any,
      },
      createElement(baseWrapper, { children })
    )
  select(store, account, chainType)
  return { store, wallet, wrapper, saved, navigation, tools }
}

/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Selects `account` on `chainType`, with a balance read for it there. */
function select(store: Store, account: Account, chainType: ChainType): void {
  store.dispatch(settingsActions.updateSettings({ chainType }))
  store.dispatch(accountActions.setCurrent(account as any))
  store.dispatch(
    accountActions.setBalanceV2({
      address: account.address,
      balance: {
        availableBalance: 10_000_000,
        unavailableBalance: 0,
        totalBalance: 10_000_000,
        chainType,
      },
    })
  )
}

/** The send screen's logic with its fee bar, as the screen renders them. */
function useSendScreenWithFeeBar() {
  const screen = useTxCreateScreenLogic()
  return { screen, feeBar: useFeeRateBarLogic({ quote: screen.feeQuote }) }
}

/** The consolidation screen's logic with its fee bar, as the screen renders them. */
function useConsolidationScreenWithFeeBar() {
  const screen = useQbitConsolidationScreenLogic()
  return { screen, feeBar: useFeeRateBarLogic({ quote: screen.feeQuote }) }
}

type SendScreen = ReturnType<typeof useSendScreenWithFeeBar>

/** Fills in the form for `recipient` and waits until Next is enabled at a Custom rate. */
async function fillSendForm(result: { current: SendScreen }, recipient: string): Promise<void> {
  act(() => {
    result.current.screen.onAddressInputChange({ address: recipient })
    result.current.screen.onAmountInputChange('0.01')
    result.current.screen.onMemoChange('rent')
    result.current.screen.onRBFChange(false)
    result.current.feeBar.setFeeOptionIndex(CUSTOM)
  })
  act(() => {
    result.current.feeBar.adjustFeeRateInput('3.5')
  })
  await waitFor(() => {
    expect(result.current.screen.disabled).toBe(false)
    expect(result.current.screen.spendSummary?.totalSpend).toMatch(/^0\.01/)
  })
  expect(result.current.screen.feeDetail).toBeDefined()
}

/**
 * The fee bar as the store's subscribers see it in the update in which
 * `switchTo` changes the account or network: the mounted fee bar chooses a
 * rate again right after, in the same act().
 */
function feeRateBarAsSwitched(store: Store, switchTo: () => void) {
  const scope = () =>
    `${store.getState().settings.chainType}:${store.getState().accounts.current.address}`
  const before = scope()
  let seen: unknown
  const unsubscribe = store.subscribe(() => {
    if (seen === undefined && scope() !== before) seen = store.getState().ui.feeRateBar
  })
  act(switchTo)
  unsubscribe()
  return seen
}

/** Waits until the fee bar has chosen the selected tier's rate from the screen's quote. */
async function expectFeeRateChosenAgain(
  store: Store,
  result: { current: { screen: { feeQuote: any } } }
) {
  await waitFor(() => {
    const { feeQuote } = result.current.screen
    expect(feeQuote.status).toBe('loaded')
    expect(store.getState().ui.feeRateBar).toMatchObject({
      feeOptionIndex: AVG,
      feeRate: 2,
      feeRateSource: { quoteRead: feeQuote.read, optionIndex: AVG },
    })
  })
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('an open send form when the account changes under it', () => {
  it('shows the initial values, with no error, estimate or total, and Next disabled', async () => {
    const { store, wallet, wrapper } = setup()
    const { result } = renderHook(useSendScreenWithFeeBar, { wrapper })
    await fillSendForm(result, recipientOn(ChainType.QBIT_MAINNET))
    const formKey = result.current.screen.formKey
    const rbfReads = wallet.getEnableRBF.mock.calls.length

    act(() => {
      select(store, SECOND, ChainType.QBIT_MAINNET)
    })

    const { screen, feeBar } = result.current
    expect(screen.toInfo).toEqual({ address: '' })
    expect(screen.inputAmount).toBe('')
    expect(screen.memo).toBe('')
    expect(screen.error).toBe('')
    expect(screen.feeDetail).toBeUndefined()
    expect(screen.spendSummary).toBeUndefined()
    expect(screen.leftBehindNote).toBeUndefined()
    expect(screen.disabled).toBe(true)
    expect(screen.formKey).not.toBe(formKey)
    expect(feeBar.feeOptionIndex).toBe(AVG)
    expect(feeBar.showCustomInput).toBe(false)
    expect(feeBar.feeRateInputVal).toBe('')
    // The saved replace-by-fee choice is read again, as a newly opened form
    // reads it: the one made in this form was saved as the default.
    await waitFor(() => expect(wallet.getEnableRBF).toHaveBeenCalledTimes(rbfReads + 1))
    await waitFor(() => expect(result.current.screen.enableRBF).toBe(false))
  })

  it('reads the saved replace-by-fee choice again, not the initial one', async () => {
    const { store, wrapper, saved } = setup()
    const { result } = renderHook(useSendScreenWithFeeBar, { wrapper })
    await waitFor(() => expect(result.current.screen.enableRBF).toBe(true))
    act(() => {
      result.current.screen.onRBFChange(false)
    })
    await waitFor(() => expect(saved.enableRBF).toBe(false))

    act(() => {
      select(store, SECOND, ChainType.QBIT_MAINNET)
    })
    // The store's initial value, until the saved choice is read.
    expect(store.getState().ui.uiTxCreateScreen.enableRBF).toBe(true)

    await waitFor(() => expect(result.current.screen.enableRBF).toBe(false))
  })

  it('settles the fee bar on a rate again, and sends for the new account', async () => {
    const { store, wrapper } = setup()
    const { result } = renderHook(useSendScreenWithFeeBar, { wrapper })
    await fillSendForm(result, recipientOn(ChainType.QBIT_MAINNET))

    act(() => {
      select(store, SECOND, ChainType.QBIT_MAINNET)
    })

    await expectFeeRateChosenAgain(store, result)
    act(() => {
      result.current.screen.onAddressInputChange({ address: recipientOn(ChainType.QBIT_MAINNET) })
      result.current.screen.onAmountInputChange('0.02')
    })
    await waitFor(() => {
      expect(result.current.screen.disabled).toBe(false)
      expect(result.current.screen.spendSummary?.totalSpend).toMatch(/^0\.02/)
    })
  })

  it('keeps everything when the same account is selected again', async () => {
    const { store, wrapper } = setup()
    const { result } = renderHook(useSendScreenWithFeeBar, { wrapper })
    await fillSendForm(result, recipientOn(ChainType.QBIT_MAINNET))
    const formKey = result.current.screen.formKey

    act(() => {
      store.dispatch(accountActions.setCurrent({ ...FIRST, flag: 1 } as any))
    })
    await act(async () => undefined)

    expect(result.current.screen.formKey).toBe(formKey)
    expect(result.current.screen.toInfo.address).toBe(recipientOn(ChainType.QBIT_MAINNET))
    expect(result.current.screen.inputAmount).toBe('0.01')
    expect(result.current.screen.memo).toBe('rent')
    expect(result.current.feeBar.feeOptionIndex).toBe(CUSTOM)
    expect(result.current.screen.disabled).toBe(false)
  })
})

describe('the form key', () => {
  it('is a new one at every clear, also for an account or network that comes back', async () => {
    const { store, wrapper } = setup()
    const { result } = renderHook(useSendScreenWithFeeBar, { wrapper })
    const keys = [result.current.screen.formKey]
    const switchTo = (account: Account, chainType: ChainType): void => {
      act(() => {
        select(store, account, chainType)
      })
      keys.push(result.current.screen.formKey)
    }

    switchTo(SECOND, ChainType.QBIT_MAINNET)
    switchTo(FIRST, ChainType.QBIT_MAINNET)
    switchTo(FIRST_ON_TESTNET, ChainType.QBIT_TESTNET4)
    switchTo(FIRST, ChainType.QBIT_MAINNET)

    expect(new Set(keys).size).toBe(keys.length)
  })

  it('changes for a round trip within one update, which reads the saved choice again', async () => {
    const { store, wallet, wrapper, saved } = setup()
    const { result } = renderHook(useSendScreenWithFeeBar, { wrapper })
    await waitFor(() => expect(result.current.screen.enableRBF).toBe(true))
    act(() => {
      result.current.screen.onRBFChange(false)
    })
    await waitFor(() => expect(saved.enableRBF).toBe(false))
    const formKey = result.current.screen.formKey
    const rbfReads = wallet.getEnableRBF.mock.calls.length

    // Away and back before the screen renders again.
    act(() => {
      select(store, SECOND, ChainType.QBIT_MAINNET)
      select(store, FIRST, ChainType.QBIT_MAINNET)
    })

    expect(store.getState().accounts.current.address).toBe(FIRST.address)
    expect(result.current.screen.formKey).not.toBe(formKey)
    await waitFor(() => expect(wallet.getEnableRBF).toHaveBeenCalledTimes(rbfReads + 1))
    await waitFor(() => expect(result.current.screen.enableRBF).toBe(false))
  })
})

describe.each(['opens', 'is cleared for another account'] as const)(
  'a read of the saved replace-by-fee choice as the form %s',
  when => {
    /**
     * The form with that read still out, showing replace-by-fee on (the
     * initial value) until it lands. The read answers what the test settles.
     */
    async function withReadOut() {
      const harness = setup()
      const opened = deferred<boolean>()
      harness.wallet.getEnableRBF.mockImplementationOnce(() => opened.promise)
      const rendered = renderHook(useSendScreenWithFeeBar, { wrapper: harness.wrapper })
      let read = opened
      if (when === 'is cleared for another account') {
        // The opened form's read lands first, and shows.
        await act(async () => opened.resolve(false))
        expect(rendered.result.current.screen.enableRBF).toBe(false)
        read = deferred<boolean>()
        harness.wallet.getEnableRBF.mockImplementationOnce(() => read.promise)
        act(() => {
          select(harness.store, SECOND, ChainType.QBIT_MAINNET)
        })
      }
      expect(harness.wallet.getEnableRBF).toHaveBeenCalledTimes(when === 'opens' ? 1 : 2)
      expect(rendered.result.current.screen.enableRBF).toBe(true)
      return { ...harness, ...rendered, read }
    }

    it('sets the box when it lands with no choice made since it started', async () => {
      const { result, read } = await withReadOut()

      await act(async () => read.resolve(false))

      expect(result.current.screen.enableRBF).toBe(false)
    })

    it('does not undo a choice the user made while it was out, and the send goes with the choice', async () => {
      const { result, read, wallet } = await withReadOut()
      // Turns replace-by-fee off, among the rest.
      await fillSendForm(result, recipientOn(ChainType.QBIT_MAINNET))

      // The read answers the choice saved when it started: on.
      await act(async () => read.resolve(true))

      expect(result.current.screen.enableRBF).toBe(false)
      act(() => {
        result.current.screen.onClickNext()
      })
      await waitFor(() =>
        expect(wallet.createSendQbitPsbt).toHaveBeenCalledWith(
          expect.objectContaining({ enableRBF: false })
        )
      )
    })

    it('gives way to a choice the user makes after it landed', async () => {
      const { result, read } = await withReadOut()
      await act(async () => read.resolve(false))

      act(() => {
        result.current.screen.onRBFChange(true)
      })

      expect(result.current.screen.enableRBF).toBe(true)
    })
  }
)

describe('the reads of the saved replace-by-fee choice at two clears', () => {
  it.each(['the later read', 'the earlier read'])(
    'land only for the later clear when %s answers first',
    async first => {
      const { store, wallet, wrapper } = setup()
      const { result } = renderHook(useSendScreenWithFeeBar, { wrapper })
      await waitFor(() => expect(wallet.getEnableRBF).toHaveBeenCalledTimes(1))
      await act(async () => undefined)
      const earlier = deferred<boolean>()
      const later = deferred<boolean>()
      wallet.getEnableRBF
        .mockImplementationOnce(() => earlier.promise)
        .mockImplementationOnce(() => later.promise)

      // Away and back, each its own update: two clears, a read for each.
      act(() => {
        select(store, SECOND, ChainType.QBIT_MAINNET)
      })
      act(() => {
        select(store, FIRST, ChainType.QBIT_MAINNET)
      })
      expect(wallet.getEnableRBF).toHaveBeenCalledTimes(3)
      // Another window saved replace-by-fee off between the two reads.
      const answers = [() => later.resolve(false), () => earlier.resolve(true)]
      for (const answer of first === 'the later read' ? answers : answers.reverse()) {
        await act(async () => answer())
      }

      expect(result.current.screen.enableRBF).toBe(false)
    }
  )
})

describe('an open send form when the network changes under it', () => {
  it('clears the form, reads the new network’s quote and settles the fee bar on it', async () => {
    const { store, wallet, wrapper } = setup()
    const { result } = renderHook(useSendScreenWithFeeBar, { wrapper })
    await fillSendForm(result, recipientOn(ChainType.QBIT_MAINNET))
    const quoteReads = wallet.getFeeSummary.mock.calls.length
    const mainnetRead = result.current.screen.feeQuote

    // As AccountUpdater takes a network switch: the network, then the
    // account's address on it.
    act(() => {
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })
    expect(result.current.screen.toInfo).toEqual({ address: '' })
    expect(result.current.screen.disabled).toBe(true)
    act(() => {
      select(store, FIRST_ON_TESTNET, ChainType.QBIT_TESTNET4)
    })

    await waitFor(() => expect(wallet.getFeeSummary.mock.calls.length).toBe(quoteReads + 1))
    await expectFeeRateChosenAgain(store, result)
    expect(result.current.screen.feeQuote).not.toBe(mainnetRead)
    act(() => {
      result.current.screen.onAddressInputChange({ address: recipientOn(ChainType.QBIT_TESTNET4) })
      result.current.screen.onAmountInputChange('0.02')
    })
    await waitFor(() => expect(result.current.screen.disabled).toBe(false))
  })
})

describe('an open consolidation screen when the account or network changes under it', () => {
  async function renderConsolidation() {
    const harness = setup()
    const rendered = renderHook(useConsolidationScreenWithFeeBar, { wrapper: harness.wrapper })
    await waitFor(() => expect(rendered.result.current.screen.canPrepare).toBe(true))
    // A Custom rate, as a user may choose before switching.
    act(() => {
      rendered.result.current.feeBar.setFeeOptionIndex(CUSTOM)
    })
    act(() => {
      rendered.result.current.feeBar.adjustFeeRateInput('3.5')
    })
    await waitFor(() => {
      expect(harness.store.getState().ui.feeRateBar.feeRate).toBe(3.5)
      expect(rendered.result.current.screen.canPrepare).toBe(true)
    })
    return { ...harness, ...rendered }
  }

  it('settles the fee bar on a rate again after another account is selected', async () => {
    const { store, result } = await renderConsolidation()

    const cleared = feeRateBarAsSwitched(store, () => select(store, SECOND, ChainType.QBIT_MAINNET))

    expect(cleared).toEqual(initialState.feeRateBar)
    await expectFeeRateChosenAgain(store, result)
    await waitFor(() => expect(result.current.screen.canPrepare).toBe(true))
  })

  it('settles the fee bar on the new network’s quote after the network changes', async () => {
    const { store, wallet, result } = await renderConsolidation()
    const quoteReads = wallet.getFeeSummary.mock.calls.length

    const cleared = feeRateBarAsSwitched(store, () =>
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    )

    expect(cleared).toEqual(initialState.feeRateBar)
    // Until the new network's quote is read, no rate is settled.
    expect(result.current.screen.canPrepare).toBe(false)
    act(() => {
      select(store, FIRST_ON_TESTNET, ChainType.QBIT_TESTNET4)
    })

    await waitFor(() => expect(wallet.getFeeSummary.mock.calls.length).toBe(quoteReads + 1))
    await expectFeeRateChosenAgain(store, result)
    await waitFor(() => expect(result.current.screen.canPrepare).toBe(true))
  })
})

describe('Next while the send is prepared', () => {
  /** The filled form's Next clicked, with the background still building the send. */
  async function clickNext() {
    const harness = setup()
    const built = deferred<{ psbtHex: string }>()
    harness.wallet.createSendQbitPsbt.mockReturnValueOnce(built.promise)
    const rendered = renderHook(useSendScreenWithFeeBar, { wrapper: harness.wrapper })
    await fillSendForm(rendered.result, recipientOn(ChainType.QBIT_MAINNET))
    act(() => {
      rendered.result.current.screen.onClickNext()
    })
    await waitFor(() => expect(harness.wallet.createSendQbitPsbt).toHaveBeenCalledTimes(1))
    return { ...harness, ...rendered, built }
  }

  type Clicked = Awaited<ReturnType<typeof clickNext>>

  /**
   * Nothing of the send built for the first account shows: no confirm
   * screen, no error, no loading overlay left up. The cleared form takes the
   * second account's send.
   */
  async function expectNothingShownForTheFirstAccount({
    result,
    navigation,
    tools,
    wallet,
  }: Clicked): Promise<void> {
    expect(navigation.navigate).not.toHaveBeenCalled()
    expect(result.current.screen.error).toBe('')
    expect(result.current.screen.toInfo).toEqual({ address: '' })
    expect(tools.showLoading).toHaveBeenLastCalledWith(false)
    expect(result.current.screen.disabled).toBe(true)

    wallet.createSendQbitPsbt.mockResolvedValueOnce({ psbtHex: 'for the second account' })
    act(() => {
      result.current.screen.onAddressInputChange({ address: recipientOn(ChainType.QBIT_MAINNET) })
      result.current.screen.onAmountInputChange('0.02')
    })
    await waitFor(() => expect(result.current.screen.disabled).toBe(false))
    act(() => {
      result.current.screen.onClickNext()
    })
    await waitFor(() =>
      expect(navigation.navigate).toHaveBeenCalledWith('TxConfirmScreen', {
        toSignData: { psbtHex: 'for the second account' },
      })
    )
    expect(navigation.navigate).toHaveBeenCalledTimes(1)
  }

  it('opens no confirm screen for a send built after another account was selected', async () => {
    const clicked = await clickNext()

    act(() => {
      select(clicked.store, SECOND, ChainType.QBIT_MAINNET)
    })
    await act(async () => {
      clicked.built.resolve({ psbtHex: 'for the first account' })
    })

    await expectNothingShownForTheFirstAccount(clicked)
  })

  it('shows no error of a send refused after another account was selected', async () => {
    const clicked = await clickNext()

    act(() => {
      select(clicked.store, SECOND, ChainType.QBIT_MAINNET)
    })
    await act(async () => {
      clicked.built.reject(new Error('refused for the first account'))
    })

    await expectNothingShownForTheFirstAccount(clicked)
  })

  it('opens no confirm screen for a send built after the network changed', async () => {
    const clicked = await clickNext()

    act(() => {
      clicked.store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })
    await act(async () => {
      clicked.built.resolve({ psbtHex: 'for Mainnet' })
    })

    expect(clicked.navigation.navigate).not.toHaveBeenCalled()
    expect(clicked.result.current.screen.error).toBe('')
  })

  it('opens the confirm screen when the account and network stay the same', async () => {
    const clicked = await clickNext()

    // The same account read again while the send is built changes nothing.
    act(() => {
      clicked.store.dispatch(accountActions.setCurrent({ ...FIRST, flag: 1 } as any))
    })
    await act(async () => {
      clicked.built.resolve({ psbtHex: 'prepared' })
    })

    expect(clicked.navigation.navigate).toHaveBeenCalledWith('TxConfirmScreen', {
      toSignData: { psbtHex: 'prepared' },
    })
  })

  it('shows the error when the account and network stay the same', async () => {
    const clicked = await clickNext()

    await act(async () => {
      clicked.built.reject(new Error('refused'))
    })

    expect(clicked.result.current.screen.error).toBe('refused')
    expect(clicked.navigation.navigate).not.toHaveBeenCalled()
  })

  /** Next clicked again while the first click's send is still built. */
  async function clickNextTwice() {
    const clicked = await clickNext()
    const later = deferred<{ psbtHex: string }>()
    clicked.wallet.createSendQbitPsbt.mockReturnValueOnce(later.promise)
    act(() => {
      clicked.result.current.screen.onClickNext()
    })
    await waitFor(() => expect(clicked.wallet.createSendQbitPsbt).toHaveBeenCalledTimes(2))
    return { ...clicked, earlier: clicked.built, later }
  }

  it.each(['the later click', 'the earlier click'])(
    'opens one confirm screen, for the later click, when %s’s send is built first',
    async first => {
      const { earlier, later, navigation } = await clickNextTwice()

      const builds = [
        () => later.resolve({ psbtHex: 'for the later click' }),
        () => earlier.resolve({ psbtHex: 'for the earlier click' }),
      ]
      for (const build of first === 'the later click' ? builds : builds.reverse()) {
        await act(async () => build())
      }

      expect(navigation.navigate).toHaveBeenCalledTimes(1)
      expect(navigation.navigate).toHaveBeenCalledWith('TxConfirmScreen', {
        toSignData: { psbtHex: 'for the later click' },
      })
    }
  )

  it('shows no error of an earlier click while a later click’s send is built', async () => {
    const { earlier, later, navigation, result } = await clickNextTwice()

    await act(async () => earlier.reject(new Error('refused for the earlier click')))

    expect(result.current.screen.error).toBe('')
    await act(async () => later.resolve({ psbtHex: 'for the later click' }))
    expect(navigation.navigate).toHaveBeenCalledTimes(1)
    expect(navigation.navigate).toHaveBeenCalledWith('TxConfirmScreen', {
      toSignData: { psbtHex: 'for the later click' },
    })
  })

  it('opens no confirm screen for an earlier click once a later click’s send is refused', async () => {
    const { earlier, later, navigation, result } = await clickNextTwice()

    await act(async () => later.reject(new Error('refused for the later click')))
    await act(async () => earlier.resolve({ psbtHex: 'for the earlier click' }))

    expect(navigation.navigate).not.toHaveBeenCalled()
    expect(result.current.screen.error).toBe('refused for the later click')
  })

  it.each(['built', 'refused'])(
    'opens nothing and shows no error for a send %s after the screen was left',
    async outcome => {
      const clicked = await clickNext()
      // The screen logs the error of a refused send as it shows it.
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
      const refusal = new Error('refused after the screen was left')
      try {
        clicked.unmount()
        await act(async () => {
          if (outcome === 'built') clicked.built.resolve({ psbtHex: 'after the screen was left' })
          else clicked.built.reject(refusal)
        })

        expect(clicked.navigation.navigate).not.toHaveBeenCalled()
        expect(log).not.toHaveBeenCalledWith(refusal)
      } finally {
        log.mockRestore()
      }
    }
  )
})
