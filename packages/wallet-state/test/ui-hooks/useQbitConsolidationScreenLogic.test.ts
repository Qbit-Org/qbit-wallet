import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { estimateQbitP2mrTransaction } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import { I18nContext } from '../../src/context/I18nContext'
import { accountActions } from '../../src/reducers/accounts'
import { settingsActions } from '../../src/reducers/settings'
import { uiActions } from '../../src/reducers/ui'
import { useQbitConsolidationScreenLogic } from '../../src/ui-hooks/useQbitConsolidationScreenLogic'
import { useFeeRateBarLogic } from '../../src/ui-hooks/useFeeRateBarLogic'
import { useTxConfirmScreenLogic } from '../../src/ui-hooks/useTxConfirmScreenLogic'
import { useTxFailScreenLogic } from '../../src/ui-hooks/useTxFailScreenLogic'
import { useTxSuccessScreenLogic } from '../../src/ui-hooks/useTxSuccessScreenLogic'
import { createHookTestHarness, createNavigationMock, createWalletMock } from './testHelpers'

/** A single-key P2MR account's batch: one 34-byte output, a 34-byte leaf, a zero-depth control block. */
const batchShape = { outputScriptLengths: [34], leafScriptLength: 34, controlBlockLength: 1 }

/** The status's maximum: qbit Core's standard size, 106 single-key inputs to one output. */
const MAX_INPUT_COUNT = 106

const status = {
  chain: ChainType.QBIT_MAINNET,
  address: 'qb1ztestaccount',
  confirmedUnspent: 812,
  pendingSpent: 106,
  pendingFunded: 1,
  overLimit: true,
  outputLimit: 500,
  maxInputCount: MAX_INPUT_COUNT,
  batchShape,
}

function batch(seed: string, maxInputs = MAX_INPUT_COUNT) {
  return {
    psbtHex: `70736274ff${seed}`,
    toSignInputs: [],
    inputCount: maxInputs,
    estimatedFee: 398_827,
    estimatedVsize: 398_827,
    qbitConsolidation: {
      confirmedOutputCount: 812,
      outputLimit: 500,
      amount: 5_000_000,
      fundingOutputCounts: Array(maxInputs).fill(2),
      maxInputs,
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

const t = (key: string, substitutions?: string | string[]) =>
  substitutions ? `${key}:${[substitutions].flat().join('|')}` : key

function i18nWrapper(inner: (props: { children: ReactNode }) => ReactNode) {
  const translate = vi.fn(t)
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      I18nContext.Provider,
      {
        value: {
          t: translate,
          locale: 'en',
          supportedLocales: [],
          localeNames: {},
          changeLocale: async () => {},
          isSpecialLocale: false,
        } as any,
      },
      createElement(inner as any, { children })
    )
  return { wrapper, t: translate }
}

/** The screen's harness; `routeState` is what the route state reads as, `undefined` included. */
function setup(...args: [routeState?: unknown]) {
  const routeState = args.length > 0 ? args[0] : {}
  const wallet = {
    ...createWalletMock(),
    getQbitConsolidationStatus: vi.fn().mockResolvedValue(status),
    createQbitConsolidationPsbt: vi.fn(),
  }
  const navigation = createNavigationMock()
  navigation.getRouteState = vi.fn(() => routeState) as any
  const harness = createHookTestHarness({ wallet: wallet as any, navigation })
  // A Custom rate: most tests here render the screen without its fee bar,
  // which alone chooses a tier's rate.
  harness.store.dispatch(
    uiActions.updateFeeRateBar({ feeRate: 2, feeRateInputVal: '2', feeOptionIndex: 3 })
  )
  return { ...harness, wallet, ...i18nWrapper(harness.wrapper) }
}

/** What a full batch of `inputCount` inputs costs at `feeRate`, by the shared estimator. */
function fullBatch(inputCount: number, feeRate: number) {
  return estimateQbitP2mrTransaction({ inputCount, ...batchShape, feeRate })
}

/** How much more in fees batches of `size` take than batches of the maximum, in whole percent. */
function extraCostPercent(size: number) {
  const perOutputRemoved = (inputCount: number) => fullBatch(inputCount, 1).vsize / (inputCount - 1)
  return Math.round((perOutputRemoved(size) / perOutputRemoved(MAX_INPUT_COUNT) - 1) * 100)
}

describe('useQbitConsolidationScreenLogic (#277)', () => {
  it('shows where the account stands and previews one batch before the confirm screen', async () => {
    const { wallet, wrapper, navigation } = setup()
    const prepared = batch('01')
    wallet.createQbitConsolidationPsbt.mockResolvedValue(prepared)
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })

    // No number of batches is promised: the explorer keeps refusing an
    // account that once passed its limit (#169).
    await waitFor(() => {
      expect(result.current.statusText).toBe('consolidation_status:812|500')
    })
    expect(result.current.refusalText).toBe('consolidation_refusal_lasts')
    expect(result.current.pendingText).toBe('consolidation_pending:106')
    expect(result.current.description).toBe('consolidation_description')
    expect(result.current.canPrepare).toBe(true)

    act(() => {
      result.current.onClickPrepare()
    })
    await waitFor(() => {
      expect(result.current.batch).toBe(prepared)
    })
    // The maximum is chosen, and passed as a number.
    expect(wallet.createQbitConsolidationPsbt).toHaveBeenCalledWith({
      feeRate: 2,
      enableRBF: true,
      maxInputs: MAX_INPUT_COUNT,
    })
    expect(result.current.batchSummary).toBe(
      'consolidation_batch_summary:106|0.05000000|QBT|398827|398.8'
    )

    act(() => {
      result.current.onClickConfirm()
    })
    expect(navigation.navigate).toHaveBeenCalledWith('TxConfirmScreen', { toSignData: prepared })
  })

  it('publishes only the latest request when two finish out of order', async () => {
    const { wallet, wrapper } = setup()
    const first = deferred<any>()
    const second = deferred<any>()
    wallet.createQbitConsolidationPsbt
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.canPrepare).toBe(true))

    act(() => {
      result.current.onClickPrepare()
    })
    act(() => {
      result.current.onClickPrepare()
    })
    const newer = batch('02')
    await act(async () => {
      second.resolve(newer)
      await second.promise
    })
    await act(async () => {
      first.resolve(batch('01'))
      await first.promise
    })

    expect(result.current.batch).toBe(newer)
  })

  it('keeps the loading overlay up until the last running request ends', async () => {
    const { wallet, wrapper, store, tools } = setup()
    const first = deferred<any>()
    const second = deferred<any>()
    wallet.createQbitConsolidationPsbt
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.canPrepare).toBe(true))

    act(() => {
      result.current.onClickPrepare()
    })
    act(() => {
      store.dispatch(uiActions.updateFeeRateBar({ feeRate: 3 }))
    })
    act(() => {
      result.current.onClickPrepare()
    })
    await act(async () => {
      first.resolve(batch('01'))
      await first.promise
    })
    expect(tools.showLoading).not.toHaveBeenCalledWith(false)

    await act(async () => {
      second.resolve(batch('02'))
      await second.promise
    })
    expect(tools.showLoading).toHaveBeenLastCalledWith(false)
    expect(result.current.batch).toEqual(batch('02'))
  })

  it('drops a batch priced at another fee rate or prepared for another account', async () => {
    const { wallet, wrapper, store } = setup()
    wallet.createQbitConsolidationPsbt.mockResolvedValue(batch('01'))
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.canPrepare).toBe(true))

    act(() => {
      result.current.onClickPrepare()
    })
    await waitFor(() => expect(result.current.batch).toBeDefined())
    act(() => {
      store.dispatch(uiActions.updateFeeRateBar({ feeRate: 3 }))
    })
    expect(result.current.batch).toBeUndefined()

    // A result that lands after the account changed is not published.
    const pending = deferred<any>()
    wallet.createQbitConsolidationPsbt.mockReturnValueOnce(pending.promise)
    act(() => {
      result.current.onClickPrepare()
    })
    act(() => {
      store.dispatch(
        accountActions.setCurrent({ ...store.getState().accounts.current, address: 'qb1zother' })
      )
    })
    await act(async () => {
      pending.resolve(batch('03'))
      await pending.promise
    })
    expect(result.current.batch).toBeUndefined()
    // On opening, after the first batch, and for the new account.
    expect(wallet.getQbitConsolidationStatus).toHaveBeenCalledTimes(3)
  })

  it('prepares a batch at 0.25 bits/vB, the relay floor, and none below it', async () => {
    const { wallet, wrapper, store } = setup()
    const prepared = batch('25')
    wallet.createQbitConsolidationPsbt.mockResolvedValue(prepared)
    act(() => {
      store.dispatch(
        (uiActions as any).updateFeeRateBar({
          feeRate: 0.25,
          feeRateInputVal: '0.25',
          feeOptionIndex: 3,
        })
      )
    })
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })

    await waitFor(() => expect(result.current.canPrepare).toBe(true))
    // A full batch of 106 inputs, 398,827 vB, at 0.25 bits/vB.
    expect(result.current.feePreview).toBe('consolidation_fee_preview:106|99707|398.8')
    act(() => {
      result.current.onClickPrepare()
    })
    await waitFor(() => expect(result.current.batch).toBe(prepared))
    expect(wallet.createQbitConsolidationPsbt).toHaveBeenCalledWith({
      feeRate: 0.25,
      enableRBF: true,
      maxInputs: MAX_INPUT_COUNT,
    })

    // A smaller batch at the same rate: 25 inputs, 94,105 vB. The cost note
    // compares sizes, which no rate changes.
    act(() => {
      result.current.onBatchSizeChange('25')
    })
    expect(result.current.feePreview).toBe('consolidation_fee_preview:25|23527|94.1')
    expect(result.current.costNote).toBe('consolidation_cost_note:25|3|106')
    expect(result.current.canPrepare).toBe(true)
    act(() => {
      result.current.onClickPrepare()
    })
    await waitFor(() =>
      expect(wallet.createQbitConsolidationPsbt).toHaveBeenLastCalledWith({
        feeRate: 0.25,
        enableRBF: true,
        maxInputs: 25,
      })
    )

    act(() => {
      store.dispatch(
        (uiActions as any).updateFeeRateBar({
          feeRate: 0.24,
          feeRateInputVal: '0.24',
          feeOptionIndex: 3,
        })
      )
    })
    expect(result.current.canPrepare).toBe(false)
    expect(result.current.feePreview).toBe('')
    expect(result.current.batch).toBeUndefined()
    expect(wallet.createQbitConsolidationPsbt).toHaveBeenCalledTimes(2)
  })

  /** The fee bar's rate: Custom, typed as `text`, or a tier's. */
  function selectRate(
    store: ReturnType<typeof setup>['store'],
    feeRate: number,
    text: string,
    feeOptionIndex = 3
  ) {
    act(() => {
      store.dispatch(
        (uiActions as any).updateFeeRateBar({ feeRate, feeRateInputVal: text, feeOptionIndex })
      )
    })
  }

  it('says the minimum is 0.25 bits/vB for a Custom rate typed below it, and nothing at it or while typing', async () => {
    const { wrapper, store } = setup()
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.canPrepare).toBe(true))

    for (const [text, feeRate, error, canPrepare] of [
      ['0.24', 0.24, 'fee_rate_below_minimum:0.25', false],
      ['0.25', 0.25, '', true],
      ['0.', 0, '', false],
      ['0.2', 0.2, 'fee_rate_below_minimum:0.25', false],
      ['0', 0, '', false],
      ['', 0, '', false],
      ['0.26', 0.26, '', true],
    ] as const) {
      selectRate(store, feeRate, text)
      // In the screen's error line.
      expect(result.current.error).toBe(error)
      expect(result.current.canPrepare).toBe(canPrepare)
    }

    // A tier's rate below the floor is not one the user typed: no batch, and nothing said.
    selectRate(store, 0.2, '', 0)
    expect(result.current.canPrepare).toBe(false)
    expect(result.current.error).toBe('')
  })

  it('puts the minimum before a failed status read, and says nothing for an account the explorer lists', async () => {
    const { wallet, wrapper, store } = setup()
    wallet.getQbitConsolidationStatus.mockRejectedValue(new Error('explorer down'))
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.error).toBe('explorer down'))

    selectRate(store, 0.24, '0.24')
    expect(result.current.error).toBe('fee_rate_below_minimum:0.25')
    selectRate(store, 0.25, '0.25')
    expect(result.current.error).toBe('explorer down')
    expect(result.current.canPrepare).toBe(true)
    cleanup()

    // An account the explorer lists has no batch to prepare at any rate.
    const within = setup()
    within.wallet.getQbitConsolidationStatus.mockResolvedValue({
      ...status,
      confirmedUnspent: 300,
      pendingSpent: 0,
      overLimit: false,
      outputLimit: null,
    })
    const { result: withinLimit } = renderHook(() => useQbitConsolidationScreenLogic(), {
      wrapper: within.wrapper,
    })
    await waitFor(() => expect(withinLimit.current.statusText).toBe('consolidation_within_limit'))
    selectRate(within.store, 0.24, '0.24')
    expect(withinLimit.current.error).toBe('')
    expect(withinLimit.current.canPrepare).toBe(false)
  })

  /** The screen with its fee bar, as the consolidation screen renders them. */
  function useScreenWithFeeBar() {
    const screen = useQbitConsolidationScreenLogic()
    return { screen, feeBar: useFeeRateBarLogic({ quote: screen.feeQuote }) }
  }

  // What the screen says for each Custom rate typed, the rate it reads as,
  // and whether a batch can be prepared at it (#182).
  it.each([
    ['', 0, '', false],
    ['0', 0, '', false],
    ['0.', 0, '', false],
    ['0.0', 0, 'fee_rate_below_minimum:0.25', false],
    ['0.00', 0, 'fee_rate_below_minimum:0.25', false],
    ['00', 0, 'fee_rate_below_minimum:0.25', false],
    ['0.1', 0.1, 'fee_rate_below_minimum:0.25', false],
    ['0.24', 0.24, 'fee_rate_below_minimum:0.25', false],
    ['0.25', 0.25, '', true],
    ['1', 1, '', true],
  ] as const)(
    'gives the minimum fee rate for a Custom rate typed as "%s" (%s bits/vB) only when it is a number below 0.25: "%s"',
    async (text, feeRate, error, canPrepare) => {
      const { wrapper, store } = setup()
      const { result } = renderHook(useScreenWithFeeBar, { wrapper })
      // At the Custom 2 bits/vB the screen opens with.
      await waitFor(() => expect(result.current.screen.canPrepare).toBe(true))

      act(() => {
        result.current.feeBar.adjustFeeRateInput(text)
      })
      await waitFor(() => expect(store.getState().ui.feeRateBar.feeRate).toBe(feeRate))
      expect(store.getState().ui.feeRateBar).toMatchObject({
        feeOptionIndex: 3,
        feeRateInputVal: text,
      })
      expect(result.current.screen.error).toBe(error)
      expect(result.current.screen.canPrepare).toBe(canPrepare)
    }
  )

  it('gives no minimum fee rate for a tier, below the floor or not, chosen after a Custom rate below it', async () => {
    const { wallet, wrapper, store } = setup()
    wallet.getFeeSummary.mockResolvedValue({
      list: [
        { title: 'slow', desc: '', feeRate: 0.2 },
        { title: 'avg', desc: '', feeRate: 0.5 },
        { title: 'fast', desc: '', feeRate: 1 },
      ],
      quote: { source: 'mempool-qbit', availability: 'available', freshness: 'live' },
    })
    const { result } = renderHook(useScreenWithFeeBar, { wrapper })
    await waitFor(() => expect(result.current.screen.canPrepare).toBe(true))
    await waitFor(() =>
      expect(result.current.feeBar.feeOptions.slice(0, 3).map(option => option.feeRate)).toEqual([
        0.2, 0.5, 1,
      ])
    )
    act(() => {
      result.current.feeBar.adjustFeeRateInput('0.0')
    })
    await waitFor(() => expect(result.current.screen.error).toBe('fee_rate_below_minimum:0.25'))

    // Slow, at 0.2 bits/vB: no batch, and no reason, which is for a rate typed.
    act(() => {
      result.current.feeBar.setFeeOptionIndex(0)
    })
    await waitFor(() =>
      expect(store.getState().ui.feeRateBar).toMatchObject({ feeOptionIndex: 0, feeRate: 0.2 })
    )
    expect(result.current.screen.error).toBe('')
    expect(result.current.screen.canPrepare).toBe(false)

    // Normal, at 0.5 bits/vB.
    act(() => {
      result.current.feeBar.setFeeOptionIndex(1)
    })
    await waitFor(() => expect(result.current.screen.canPrepare).toBe(true))
    expect(store.getState().ui.feeRateBar.feeRate).toBe(0.5)
    expect(result.current.screen.error).toBe('')
  })

  it('puts the minimum for a zero typed as "0.00" before a failed status read, and says nothing for an account the explorer lists', async () => {
    const { wallet, wrapper, store } = setup()
    wallet.getQbitConsolidationStatus.mockRejectedValue(new Error('explorer down'))
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.error).toBe('explorer down'))

    selectRate(store, 0, '0.00')
    expect(result.current.error).toBe('fee_rate_below_minimum:0.25')
    expect(result.current.canPrepare).toBe(false)
    // "0." is still being typed: the status read's error, and no batch.
    selectRate(store, 0, '0.')
    expect(result.current.error).toBe('explorer down')
    expect(result.current.canPrepare).toBe(false)
    cleanup()

    // An account the explorer lists has no batch to prepare at any rate.
    const within = setup()
    within.wallet.getQbitConsolidationStatus.mockResolvedValue({
      ...status,
      confirmedUnspent: 300,
      pendingSpent: 0,
      overLimit: false,
      outputLimit: null,
    })
    const { result: withinLimit } = renderHook(() => useQbitConsolidationScreenLogic(), {
      wrapper: within.wrapper,
    })
    await waitFor(() => expect(withinLimit.current.statusText).toBe('consolidation_within_limit'))
    selectRate(within.store, 0, '0.00')
    expect(withinLimit.current.error).toBe('')
    expect(withinLimit.current.canPrepare).toBe(false)
  })

  it('reports a failed batch without previewing anything', async () => {
    const { wallet, wrapper } = setup()
    wallet.createQbitConsolidationPsbt.mockRejectedValue(
      new Error('No confirmed outputs are ready to consolidate yet.')
    )
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.canPrepare).toBe(true))

    act(() => {
      result.current.onClickPrepare()
    })

    await waitFor(() => {
      expect(result.current.error).toBe('No confirmed outputs are ready to consolidate yet.')
    })
    expect(result.current.batch).toBeUndefined()
    expect(result.current.canPrepare).toBe(true)
  })

  it('goes by the explorer refusing, not by the count, for an account it still refuses (#169)', async () => {
    const { wallet, wrapper } = setup()
    // Within the stated limit by count, and refused all the same: electrs
    // counts the most the address held since it last cached its outputs.
    wallet.getQbitConsolidationStatus.mockResolvedValue({
      ...status,
      confirmedUnspent: 40_000,
      pendingSpent: 0,
      outputLimit: 50_000,
    })
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })

    await waitFor(() => {
      expect(result.current.statusText).toBe('consolidation_status:40000|50000')
    })
    expect(result.current.refusalText).toBe('consolidation_refusal_lasts')
    expect(result.current.overLimit).toBe(true)
    expect(result.current.canPrepare).toBe(true)
    // Whatever the size of the next batch.
    act(() => {
      result.current.onBatchSizeChange('abc')
    })
    expect(result.current.statusText).toBe('consolidation_status:40000|50000')
  })

  it('says the explorer refuses without a limit when its refusal states none (#169)', async () => {
    const { wallet, wrapper } = setup()
    wallet.getQbitConsolidationStatus.mockResolvedValue({ ...status, outputLimit: null })
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })

    await waitFor(() => {
      expect(result.current.statusText).toBe('consolidation_status_no_limit:812')
    })
    // Nor why the refusal lasts: that is electrs' limit, which it did not name.
    expect(result.current.refusalText).toBe('')
    expect(result.current.canPrepare).toBe(true)
  })

  it('keeps a failed status read visible and still lets a batch be prepared', async () => {
    const { wallet, wrapper, store } = setup()
    wallet.getQbitConsolidationStatus
      .mockRejectedValueOnce(new Error('HTTP 500'))
      .mockResolvedValue(status)
    const prepared = batch('01')
    wallet.createQbitConsolidationPsbt.mockResolvedValue(prepared)
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })

    await waitFor(() => expect(result.current.error).toBe('HTTP 500'))
    expect(result.current.canPrepare).toBe(true)
    // A fee-rate change does not hide why the status is missing.
    act(() => {
      store.dispatch(uiActions.updateFeeRateBar({ feeRate: 3 }))
    })
    expect(result.current.error).toBe('HTTP 500')

    act(() => {
      result.current.onClickPrepare()
    })
    // The background checked the counts; the status is read again with the batch.
    await waitFor(() => expect(result.current.batch).toBe(prepared))
    await waitFor(() => expect(result.current.statusText).toBe('consolidation_status:812|500'))
    expect(result.current.error).toBe('')
  })

  it('offers nothing to do for an account the explorer lists, whatever its count', async () => {
    const { wallet, wrapper } = setup()
    // More outputs than an older explorer's 500, listed by one whose limit is higher.
    wallet.getQbitConsolidationStatus.mockResolvedValue({
      ...status,
      pendingSpent: 0,
      overLimit: false,
      outputLimit: null,
    })
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })

    await waitFor(() => {
      expect(result.current.statusText).toBe('consolidation_within_limit')
    })
    expect(result.current.refusalText).toBe('')
    expect(result.current.canPrepare).toBe(false)
  })

  /** A quote with qbit metadata whose Normal is `normal` bits/vB. */
  function quoteWithNormal(normal: number) {
    return {
      list: [
        { title: 'slow', desc: '', feeRate: normal - 1 },
        { title: 'avg', desc: '', feeRate: normal },
        { title: 'fast', desc: '', feeRate: normal + 1 },
      ],
      quote: { source: 'mempool-qbit', availability: 'available', freshness: 'live' },
    }
  }

  it('prepares no batch until its fee bar chose the selected tier’s rate from the screen’s quote, again after a network change', async () => {
    const { wallet, wrapper, store } = setup()
    // As the wallet leaves it: Normal, at the fee bar's default of 1 bit/vB.
    store.dispatch(uiActions.resetFeeRateBar())
    const mainnetRead = deferred<any>()
    wallet.getFeeSummary.mockReturnValueOnce(mainnetRead.promise)
    // Whether each render offered a batch, at which rate and on which network.
    const renders: { network: ChainType; feeRate: number; canPrepare: boolean }[] = []
    const { result } = renderHook(
      () => {
        const screen = useQbitConsolidationScreenLogic()
        useFeeRateBarLogic({ quote: screen.feeQuote })
        renders.push({
          network: store.getState().settings.chainType,
          feeRate: store.getState().ui.feeRateBar.feeRate,
          canPrepare: screen.canPrepare,
        })
        return screen
      },
      { wrapper }
    )

    await waitFor(() => expect(result.current.statusText).toBe('consolidation_status:812|500'))
    expect(result.current.canPrepare).toBe(false)

    await act(async () => {
      mainnetRead.resolve(quoteWithNormal(5))
    })
    await waitFor(() => expect(result.current.canPrepare).toBe(true))
    expect(store.getState().ui.feeRateBar.feeRate).toBe(5)

    const testnetRead = deferred<any>()
    wallet.getFeeSummary.mockReturnValueOnce(testnetRead.promise)
    act(() => {
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })
    await waitFor(() => expect(wallet.getQbitConsolidationStatus).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.statusText).toBe('consolidation_status:812|500'))
    expect(store.getState().ui.feeRateBar.feeRate).toBe(5)
    expect(result.current.canPrepare).toBe(false)

    await act(async () => {
      testnetRead.resolve(quoteWithNormal(7))
    })
    await waitFor(() => expect(result.current.canPrepare).toBe(true))
    expect(store.getState().ui.feeRateBar.feeRate).toBe(7)
    // Never at the default rate, nor on testnet at mainnet's.
    const offered = renders.filter(render => render.canPrepare)
    expect(offered.length).toBeGreaterThan(0)
    for (const render of offered) {
      expect(render.feeRate).toBe(render.network === ChainType.QBIT_MAINNET ? 5 : 7)
    }
  })

  it('offers no batch priced at an earlier rate, from the render in which the rate changes', async () => {
    const { wallet, wrapper, store } = setup()
    // Normal, at 5 bits/vB once the quote lands.
    store.dispatch(uiActions.resetFeeRateBar())
    wallet.getFeeSummary.mockResolvedValue(quoteWithNormal(5))
    const prepared = batch('01')
    wallet.createQbitConsolidationPsbt.mockResolvedValue(prepared)
    // The rate in the store and the batch offered, in each render.
    const renders: { feeRate: number; batch: unknown }[] = []
    const { result } = renderHook(
      () => {
        const screen = useQbitConsolidationScreenLogic()
        const feeBar = useFeeRateBarLogic({ quote: screen.feeQuote })
        renders.push({ feeRate: store.getState().ui.feeRateBar.feeRate, batch: screen.batch })
        return { screen, feeBar }
      },
      { wrapper }
    )
    await waitFor(() => expect(result.current.screen.canPrepare).toBe(true))
    act(() => {
      result.current.screen.onClickPrepare()
    })
    await waitFor(() => expect(result.current.screen.batch).toBe(prepared))
    const prepared5 = renders.length

    // Fast, at 6 bits/vB.
    act(() => {
      result.current.feeBar.setFeeOptionIndex(2)
    })
    await waitFor(() => expect(result.current.screen.canPrepare).toBe(true))
    expect(store.getState().ui.feeRateBar.feeRate).toBe(6)
    expect(result.current.screen.batch).toBeUndefined()
    const switched = renders.length

    act(() => {
      result.current.screen.onClickPrepare()
    })
    await waitFor(() => expect(result.current.screen.batch).toBe(prepared))
    const prepared6 = renders.length

    // A Custom rate of 7 bits/vB.
    act(() => {
      store.dispatch(
        uiActions.updateFeeRateBar({ feeRate: 7, feeRateInputVal: '7', feeOptionIndex: 3 })
      )
    })
    await waitFor(() => expect(result.current.screen.canPrepare).toBe(true))

    // Never a batch priced at 5 bits/vB offered at 6, nor one priced at 6 at 7.
    expect(renders.slice(prepared5, switched).filter(r => r.feeRate !== 5 && r.batch)).toEqual([])
    expect(renders.slice(prepared6).filter(r => r.feeRate !== 6 && r.batch)).toEqual([])
    expect(result.current.screen.batch).toBeUndefined()
  })

  it('shows a rejection from the wallet proxy, a plain object, by its message (#170)', async () => {
    const { wallet, wrapper } = setup()
    // The popup's proxy rejects with the background's error serialized as
    // { message, stack }, not as an Error.
    wallet.getQbitConsolidationStatus
      .mockRejectedValueOnce({
        message: 'status unavailable',
        stack: 'at getQbitConsolidationStatus',
      })
      .mockResolvedValue(status)
    wallet.createQbitConsolidationPsbt
      .mockRejectedValueOnce({ message: 'x', stack: 'at createQbitConsolidationPsbt' })
      .mockRejectedValueOnce({ stack: 'no message' })
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })

    await waitFor(() => expect(result.current.error).toBe('status unavailable'))

    act(() => {
      result.current.onClickPrepare()
    })
    await waitFor(() => expect(result.current.error).toBe('x'))
    expect(result.current.error).not.toContain('[object Object]')

    // A rejection without a message reads as an unknown error, not as nothing.
    act(() => {
      result.current.onClickPrepare()
    })
    await waitFor(() => expect(result.current.error).toBe('unknown_error'))
  })
})

describe('useQbitConsolidationScreenLogic batch size (#170)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens at the maximum, and Max restores it after an edit', async () => {
    const { wrapper } = setup()
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })

    // Nothing to choose from until the maximum is known.
    expect(result.current.showBatchSize).toBe(false)
    expect(result.current.batchSizeText).toBe('')
    await waitFor(() => expect(result.current.showBatchSize).toBe(true))
    expect(result.current.batchSizeText).toBe('106')
    expect(result.current.batchSize).toBe(MAX_INPUT_COUNT)
    expect(result.current.maxBatchSize).toBe(MAX_INPUT_COUNT)
    expect(result.current.batchSizeLabel).toBe('consolidation_batch_size_label')
    expect(result.current.batchSizeRange).toBe('consolidation_batch_size_range:2|106')
    expect(result.current.batchSizeError).toBe('')
    // No note at the maximum.
    expect(result.current.costNote).toBe('')

    act(() => {
      result.current.onBatchSizeChange('25')
    })
    expect(result.current.batchSizeText).toBe('25')
    expect(result.current.batchSize).toBe(25)

    act(() => {
      result.current.onClickBatchSizeMax()
    })
    expect(result.current.batchSizeText).toBe('106')
    expect(result.current.batchSize).toBe(MAX_INPUT_COUNT)
    expect(result.current.costNote).toBe('')
  })

  it('refuses a size that is not a whole number from 2 to the maximum, and accepts 2 and the maximum', async () => {
    const { wallet, wrapper } = setup()
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.canPrepare).toBe(true))

    const refused = [
      '',
      '0',
      '1',
      '107',
      '2.5',
      '1e1',
      'abc',
      ' ',
      ' 25',
      '25 ',
      '-5',
      '+5',
      '0x10',
      '٢٥',
      '99999999999999999999',
    ]
    for (const text of refused) {
      act(() => {
        result.current.onBatchSizeChange(text)
      })
      expect(result.current.batchSizeText).toBe(text)
      expect(result.current.batchSize).toBeUndefined()
      expect(result.current.batchSizeError).toBe('consolidation_batch_size_invalid:2|106')
      expect(result.current.canPrepare).toBe(false)
      // Nothing is derived from a size the range refuses, and the status
      // line does not depend on the size (#169).
      expect(result.current.statusText).toBe('consolidation_status:812|500')
      expect(result.current.feePreview).toBe('')
      expect(result.current.costNote).toBe('')
      // Nor is one sent, should Prepare be reached anyway.
      act(() => {
        result.current.onClickPrepare()
      })
    }
    expect(wallet.createQbitConsolidationPsbt).not.toHaveBeenCalled()

    for (const [text, size] of [
      ['2', 2],
      ['106', 106],
      ['025', 25],
    ] as const) {
      act(() => {
        result.current.onBatchSizeChange(text)
      })
      expect(result.current.batchSize).toBe(size)
      expect(result.current.batchSizeError).toBe('')
      expect(result.current.canPrepare).toBe(true)
    }
  })

  it('requests the chosen size, and promises no number of batches by it (#169)', async () => {
    const { wallet, wrapper } = setup()
    wallet.createQbitConsolidationPsbt.mockResolvedValue(batch('01', 25))
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.canPrepare).toBe(true))

    // The explorer keeps refusing an account that once passed its limit, so
    // no size brings it within that limit in some number of batches.
    for (const size of ['25', '10', '2']) {
      act(() => {
        result.current.onBatchSizeChange(size)
      })
      expect(result.current.statusText).toBe('consolidation_status:812|500')
    }

    act(() => {
      result.current.onBatchSizeChange('25')
    })
    act(() => {
      result.current.onClickPrepare()
    })
    await waitFor(() => expect(result.current.batch).toBeDefined())
    expect(wallet.createQbitConsolidationPsbt).toHaveBeenLastCalledWith({
      feeRate: 2,
      enableRBF: true,
      maxInputs: 25,
    })
  })

  it('drops a batch prepared at another size, and never publishes a prepare still running for one', async () => {
    const { wallet, wrapper } = setup()
    const atMax = batch('01')
    wallet.createQbitConsolidationPsbt.mockResolvedValueOnce(atMax)
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.canPrepare).toBe(true))

    act(() => {
      result.current.onClickPrepare()
    })
    await waitFor(() => expect(result.current.batch).toBe(atMax))
    act(() => {
      result.current.onBatchSizeChange('25')
    })
    expect(result.current.batch).toBeUndefined()
    // Choosing the same size again does not bring it back.
    act(() => {
      result.current.onClickBatchSizeMax()
    })
    expect(result.current.batch).toBeUndefined()

    // Two requests for two sizes, finishing out of order: only the one for
    // the size now chosen is published.
    const for25 = deferred<any>()
    const for30 = deferred<any>()
    wallet.createQbitConsolidationPsbt
      .mockReturnValueOnce(for25.promise)
      .mockReturnValueOnce(for30.promise)
    act(() => {
      result.current.onBatchSizeChange('25')
    })
    act(() => {
      result.current.onClickPrepare()
    })
    act(() => {
      result.current.onBatchSizeChange('30')
    })
    act(() => {
      result.current.onClickPrepare()
    })
    const at30 = batch('30', 30)
    await act(async () => {
      for30.resolve(at30)
      await for30.promise
    })
    await act(async () => {
      for25.resolve(batch('25', 25))
      await for25.promise
    })
    expect(result.current.batch).toBe(at30)

    // A prepare for a size since changed never publishes, even once the
    // size is changed back.
    const again = deferred<any>()
    wallet.createQbitConsolidationPsbt.mockReturnValueOnce(again.promise)
    act(() => {
      result.current.onBatchSizeChange('40')
    })
    act(() => {
      result.current.onClickPrepare()
    })
    act(() => {
      result.current.onBatchSizeChange('41')
    })
    act(() => {
      result.current.onBatchSizeChange('40')
    })
    await act(async () => {
      again.resolve(batch('40', 40))
      await again.promise
    })
    expect(result.current.batch).toBeUndefined()
    expect(
      wallet.createQbitConsolidationPsbt.mock.calls.map(([request]) => request.maxInputs)
    ).toEqual([MAX_INPUT_COUNT, 25, 30, 40])
  })

  it('offers no batch prepared at an earlier size, from the render in which the size changes', async () => {
    const { wallet, wrapper } = setup()
    const prepared = batch('01')
    wallet.createQbitConsolidationPsbt.mockResolvedValue(prepared)
    // The size typed and the batch offered, in each render.
    const renders: { text: string; batch: unknown }[] = []
    const { result } = renderHook(
      () => {
        const screen = useQbitConsolidationScreenLogic()
        renders.push({ text: screen.batchSizeText, batch: screen.batch })
        return screen
      },
      { wrapper }
    )
    await waitFor(() => expect(result.current.canPrepare).toBe(true))
    act(() => {
      result.current.onClickPrepare()
    })
    await waitFor(() => expect(result.current.batch).toBe(prepared))
    const preparedAt = renders.length

    act(() => {
      result.current.onBatchSizeChange('25')
    })
    expect(renders.slice(preparedAt).filter(render => render.batch)).toEqual([])
    expect(renders.slice(preparedAt).some(render => render.text === '25')).toBe(true)
  })

  it('prices a full batch of the chosen size at the settled rate, and nothing else', async () => {
    const { wallet, wrapper, store } = setup()
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.canPrepare).toBe(true))

    const atMax = fullBatch(MAX_INPUT_COUNT, 2)
    expect(result.current.feePreview).toBe(
      `consolidation_fee_preview:106|${atMax.fee}|${(atMax.vsize / 1000).toFixed(1)}`
    )
    expect(result.current.feePreview).toBe('consolidation_fee_preview:106|797654|398.8')
    act(() => {
      result.current.onBatchSizeChange('25')
    })
    const at25 = fullBatch(25, 2)
    expect(result.current.feePreview).toBe(
      `consolidation_fee_preview:25|${at25.fee}|${(at25.vsize / 1000).toFixed(1)}`
    )
    expect(result.current.feePreview).toBe('consolidation_fee_preview:25|188210|94.1')

    // Not at a rate past the wallet's ceiling.
    act(() => {
      store.dispatch(
        uiActions.updateFeeRateBar({ feeRate: 20_000, feeRateInputVal: '20000', feeOptionIndex: 3 })
      )
    })
    await waitFor(() => expect(result.current.feePreview).toBe(''))

    // Nor before the rate is settled: Normal, until the quote lands.
    const read = deferred<any>()
    wallet.getFeeSummary.mockReturnValueOnce(read.promise)
    const { result: unsettled } = renderHook(
      () => {
        const screen = useQbitConsolidationScreenLogic()
        useFeeRateBarLogic({ quote: screen.feeQuote })
        return screen
      },
      { wrapper }
    )
    act(() => {
      store.dispatch(uiActions.resetFeeRateBar())
    })
    await waitFor(() => expect(unsettled.current.showBatchSize).toBe(true))
    expect(unsettled.current.feePreview).toBe('')
    await act(async () => {
      read.resolve({
        list: [
          { title: 'slow', desc: '', feeRate: 4 },
          { title: 'avg', desc: '', feeRate: 5 },
          { title: 'fast', desc: '', feeRate: 6 },
        ],
        quote: { source: 'mempool-qbit', availability: 'available', freshness: 'live' },
      })
    })
    const at5 = fullBatch(MAX_INPUT_COUNT, 5)
    await waitFor(() =>
      expect(unsettled.current.feePreview).toBe(
        `consolidation_fee_preview:106|${at5.fee}|${(at5.vsize / 1000).toFixed(1)}`
      )
    )
  })

  it('says how much more smaller batches take in fees than the largest', async () => {
    const { wrapper } = setup()
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.showBatchSize).toBe(true))

    // Computed from the shared estimator: a batch of n removes n - 1 outputs.
    expect(extraCostPercent(25)).toBe(3)
    expect(extraCostPercent(10)).toBe(10)
    for (const size of [2, 10, 25, 40, 50, 60]) {
      act(() => {
        result.current.onBatchSizeChange(String(size))
      })
      expect(result.current.costNote).toBe(
        `consolidation_cost_note:${size}|${extraCostPercent(size)}|106`
      )
    }
    // Never "about 0%".
    for (const size of [70, 80, 102, 105]) {
      expect(extraCostPercent(size)).toBe(0)
      act(() => {
        result.current.onBatchSizeChange(String(size))
      })
      expect(result.current.costNote).toBe(`consolidation_cost_note_small:${size}|106`)
    }
    // Not at the maximum, nor for a size the range refuses.
    for (const text of ['106', '1', '107', '']) {
      act(() => {
        result.current.onBatchSizeChange(text)
      })
      expect(result.current.costNote).toBe('')
    }
  })

  it('opens at the size the route names, and at the maximum when it names none or one out of range', async () => {
    const opened = async (routeState: any, maxInputCount = MAX_INPUT_COUNT) => {
      const { wallet, wrapper } = setup(routeState)
      wallet.getQbitConsolidationStatus.mockResolvedValue({ ...status, maxInputCount })
      const { result, unmount } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
      await waitFor(() => expect(result.current.showBatchSize).toBe(true))
      const text = result.current.batchSizeText
      unmount()
      return text
    }

    expect(await opened({ maxInputs: 25 })).toBe('25')
    expect(await opened({ maxInputs: 2 })).toBe('2')
    expect(await opened({ maxInputs: 102 })).toBe('102')
    expect(await opened({ maxInputs: 106 })).toBe('106')
    // Missing, malformed or out of range: the maximum.
    expect(await opened({})).toBe('106')
    expect(await opened(undefined)).toBe('106')
    expect(await opened({ maxInputs: 107 })).toBe('106')
    expect(await opened({ maxInputs: 250 })).toBe('106')
    expect(await opened({ maxInputs: 1 })).toBe('106')
    expect(await opened({ maxInputs: 0 })).toBe('106')
    expect(await opened({ maxInputs: 2.5 })).toBe('106')
    expect(await opened({ maxInputs: '25' })).toBe('106')
    expect(await opened({ maxInputs: Number.NaN })).toBe('106')
    expect(await opened({ maxInputs: Number.POSITIVE_INFINITY })).toBe('106')
    // Checked against the maximum the status reports now.
    expect(await opened({ maxInputs: 90 }, 80)).toBe('80')
    expect(await opened({ maxInputs: 60 }, 80)).toBe('60')
  })

  it('without a known maximum, offers no size and prepares at the background’s own maximum', async () => {
    const { wallet, wrapper } = setup()
    const statusRead = deferred<any>()
    wallet.getQbitConsolidationStatus
      .mockReturnValueOnce(statusRead.promise)
      .mockResolvedValue(status)
    const prepared = batch('01')
    wallet.createQbitConsolidationPsbt.mockResolvedValue(prepared)
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })

    // While the status loads: no size, and nothing to prepare yet.
    expect(result.current.showBatchSize).toBe(false)
    expect(result.current.batchSize).toBeUndefined()
    expect(result.current.batchSizeError).toBe('')
    expect(result.current.canPrepare).toBe(false)

    // A failed read does not stop a batch; it carries no size, so the
    // background uses its maximum.
    await act(async () => {
      statusRead.reject({ message: 'HTTP 500' })
    })
    await waitFor(() => expect(result.current.error).toBe('HTTP 500'))
    expect(result.current.showBatchSize).toBe(false)
    expect(result.current.feePreview).toBe('')
    expect(result.current.costNote).toBe('')
    expect(result.current.canPrepare).toBe(true)
    act(() => {
      result.current.onClickPrepare()
    })
    await waitFor(() => expect(result.current.batch).toBe(prepared))
    expect(wallet.createQbitConsolidationPsbt).toHaveBeenCalledWith({ feeRate: 2, enableRBF: true })

    // The status read with the batch brings the maximum. The batch was
    // prepared at the maximum, so it stays.
    await waitFor(() => expect(result.current.showBatchSize).toBe(true))
    expect(result.current.batchSizeText).toBe('106')
    expect(result.current.batch).toBe(prepared)
  })

  it('without a known maximum, prepares at the size the route names, and keeps that batch once the status loads', async () => {
    // A size below the maximum, and the maximum itself.
    for (const size of [25, MAX_INPUT_COUNT]) {
      const { wallet, wrapper } = setup({ maxInputs: size })
      wallet.getQbitConsolidationStatus
        .mockRejectedValueOnce({ message: 'HTTP 500' })
        .mockResolvedValue(status)
      const prepared = batch('01', size)
      wallet.createQbitConsolidationPsbt.mockResolvedValue(prepared)
      const { result, unmount } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })

      await waitFor(() => expect(result.current.canPrepare).toBe(true))
      expect(result.current.showBatchSize).toBe(false)
      act(() => {
        result.current.onClickPrepare()
      })
      // The background checks the size against its maximum, as it checks a chosen one.
      expect(wallet.createQbitConsolidationPsbt).toHaveBeenCalledWith({
        feeRate: 2,
        enableRBF: true,
        maxInputs: size,
      })
      await waitFor(() => expect(result.current.batch).toBe(prepared))

      // The status read with the batch brings the maximum. The size is the
      // one the route named, so the batch prepared at it stays.
      await waitFor(() => expect(result.current.showBatchSize).toBe(true))
      expect(result.current.batchSizeText).toBe(String(size))
      expect(result.current.batch).toBe(prepared)
      expect(result.current.batchSummary).toContain(`consolidation_batch_summary:${size}|`)
      unmount()
    }
  })

  it('without a known maximum, sends no size for a route naming none that could be one', async () => {
    for (const maxInputs of [undefined, null, 1, 0, -5, 2.5, '25', Number.NaN]) {
      const { wallet, wrapper } = setup({ maxInputs })
      wallet.getQbitConsolidationStatus.mockRejectedValue({ message: 'HTTP 500' })
      wallet.createQbitConsolidationPsbt.mockResolvedValue(batch('01'))
      const { result, unmount } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })

      await waitFor(() => expect(result.current.canPrepare).toBe(true))
      act(() => {
        result.current.onClickPrepare()
      })
      expect(wallet.createQbitConsolidationPsbt).toHaveBeenCalledWith({
        feeRate: 2,
        enableRBF: true,
      })
      unmount()
    }
  })

  it('without a known maximum, sends a size past the maximum for the background to refuse, and shows why', async () => {
    // A size past the maximum, as a route names one when the maximum is
    // lower for the account or version the screen opens on than for the
    // batch the size came from.
    const { wallet, wrapper } = setup({ maxInputs: 107 })
    wallet.getQbitConsolidationStatus.mockRejectedValue({ message: 'HTTP 500' })
    wallet.createQbitConsolidationPsbt.mockRejectedValue({
      message: 'maxInputs must be a whole number from 2 to 106',
      stack: 'at createQbitConsolidationPsbt',
    })
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })

    await waitFor(() => expect(result.current.canPrepare).toBe(true))
    act(() => {
      result.current.onClickPrepare()
    })

    expect(wallet.createQbitConsolidationPsbt).toHaveBeenCalledWith({
      feeRate: 2,
      enableRBF: true,
      maxInputs: 107,
    })
    await waitFor(() =>
      expect(result.current.error).toBe('maxInputs must be a whole number from 2 to 106')
    )
    expect(result.current.batch).toBeUndefined()
  })

  it('reads the status again after the background refuses the route’s size, and then prepares at the maximum', async () => {
    // A size past the maximum, as a route names one when the maximum is
    // lower for the account or version the screen opens on than for the
    // batch the size came from.
    const { wallet, wrapper } = setup({ maxInputs: 107 })
    wallet.getQbitConsolidationStatus
      .mockRejectedValueOnce({ message: 'HTTP 500' })
      .mockResolvedValue(status)
    const prepared = batch('01')
    wallet.createQbitConsolidationPsbt
      .mockRejectedValueOnce({
        message: 'maxInputs must be a whole number from 2 to 106',
        stack: 'at createQbitConsolidationPsbt',
      })
      .mockResolvedValue(prepared)
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })

    await waitFor(() => expect(result.current.canPrepare).toBe(true))
    expect(result.current.showBatchSize).toBe(false)
    act(() => {
      result.current.onClickPrepare()
    })
    expect(wallet.createQbitConsolidationPsbt).toHaveBeenLastCalledWith({
      feeRate: 2,
      enableRBF: true,
      maxInputs: 107,
    })
    await waitFor(() =>
      expect(result.current.error).toBe('maxInputs must be a whole number from 2 to 106')
    )

    // With the maximum unknown, the refusal reads the status again. It loads
    // now, so the field opens at the maximum, the route's size being past it.
    await waitFor(() => expect(result.current.showBatchSize).toBe(true))
    expect(wallet.getQbitConsolidationStatus).toHaveBeenCalledTimes(2)
    expect(result.current.batchSizeText).toBe('106')
    expect(result.current.batchSize).toBe(MAX_INPUT_COUNT)
    expect(result.current.canPrepare).toBe(true)

    act(() => {
      result.current.onClickPrepare()
    })
    expect(wallet.createQbitConsolidationPsbt).toHaveBeenLastCalledWith({
      feeRate: 2,
      enableRBF: true,
      maxInputs: MAX_INPUT_COUNT,
    })
    await waitFor(() => expect(result.current.batch).toBe(prepared))
    expect(result.current.error).toBe('')
  })

  it('reads no status after a failed prepare once the maximum is known, and leaves no status error behind', async () => {
    const { wallet, wrapper, store } = setup()
    // The read the screen opens with loads; any later one would fail.
    wallet.getQbitConsolidationStatus
      .mockResolvedValueOnce(status)
      .mockRejectedValue({ message: 'status unavailable' })
    wallet.createQbitConsolidationPsbt.mockRejectedValue({ message: 'HTTP 502' })
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.canPrepare).toBe(true))
    expect(result.current.maxBatchSize).toBe(MAX_INPUT_COUNT)

    act(() => {
      result.current.onClickPrepare()
    })
    await waitFor(() => expect(result.current.error).toBe('HTTP 502'))
    // Whatever the failure set off has run.
    await act(async () => {})
    expect(wallet.getQbitConsolidationStatus).toHaveBeenCalledTimes(1)

    // Once the prepare's error clears, no status error stands behind the
    // loaded status.
    act(() => {
      store.dispatch(uiActions.updateFeeRateBar({ feeRate: 3 }))
    })
    expect(result.current.error).toBe('')
    expect(result.current.statusText).toBe('consolidation_status:812|500')
    expect(result.current.canPrepare).toBe(true)
  })

  it('publishes only the latest status read a refusal starts, and none for an account left', async () => {
    const { wallet, wrapper } = setup({ maxInputs: 107 })
    const afterFirst = deferred<any>()
    const afterSecond = deferred<any>()
    wallet.getQbitConsolidationStatus
      .mockRejectedValueOnce({ message: 'HTTP 500' })
      .mockReturnValueOnce(afterFirst.promise)
      .mockReturnValueOnce(afterSecond.promise)
    wallet.createQbitConsolidationPsbt.mockRejectedValue({
      message: 'maxInputs must be a whole number from 2 to 106',
    })
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })

    // Two refusals, each followed by a status read; the first read still
    // runs as the second refusal starts another.
    for (const reads of [2, 3]) {
      await waitFor(() => expect(result.current.canPrepare).toBe(true))
      act(() => {
        result.current.onClickPrepare()
      })
      await waitFor(() => expect(wallet.getQbitConsolidationStatus).toHaveBeenCalledTimes(reads))
    }

    // The later read lands first and is published; the earlier one, landing
    // after it, is not.
    await act(async () => {
      afterSecond.resolve(status)
      await afterSecond.promise
    })
    expect(result.current.batchSizeText).toBe('106')
    expect(result.current.statusText).toBe('consolidation_status:812|500')
    await act(async () => {
      afterFirst.resolve({ ...status, confirmedUnspent: 900, maxInputCount: 50 })
      await afterFirst.promise
    })
    expect(result.current.maxBatchSize).toBe(MAX_INPUT_COUNT)
    expect(result.current.batchSizeText).toBe('106')
    expect(result.current.statusText).toBe('consolidation_status:812|500')

    // A refusal's read still running when the account changes is not
    // published for the account the screen moved to. A refusal reads the
    // status only while the maximum is unknown, so this one comes on a
    // screen whose status read failed.
    const moving = setup({ maxInputs: 107 })
    const leftBehind = deferred<any>()
    const forOther = deferred<any>()
    moving.wallet.getQbitConsolidationStatus
      .mockRejectedValueOnce({ message: 'HTTP 500' })
      .mockReturnValueOnce(leftBehind.promise)
      .mockReturnValueOnce(forOther.promise)
    moving.wallet.createQbitConsolidationPsbt.mockRejectedValue({
      message: 'maxInputs must be a whole number from 2 to 106',
    })
    const { result: moved } = renderHook(() => useQbitConsolidationScreenLogic(), {
      wrapper: moving.wrapper,
    })
    await waitFor(() => expect(moved.current.canPrepare).toBe(true))
    act(() => {
      moved.current.onClickPrepare()
    })
    await waitFor(() => expect(moving.wallet.getQbitConsolidationStatus).toHaveBeenCalledTimes(2))
    act(() => {
      moving.store.dispatch(
        accountActions.setCurrent({
          ...moving.store.getState().accounts.current,
          address: 'qb1zother',
        })
      )
    })
    expect(moving.wallet.getQbitConsolidationStatus).toHaveBeenCalledTimes(3)
    await act(async () => {
      leftBehind.resolve(status)
      await leftBehind.promise
    })
    expect(moved.current.status).toBeUndefined()
    expect(moved.current.showBatchSize).toBe(false)
    const otherStatus = { ...status, address: 'qb1zother', confirmedUnspent: 640 }
    await act(async () => {
      forOther.resolve(otherStatus)
      await forOther.promise
    })
    expect(moved.current.status).toBe(otherStatus)
  })

  it('without a known maximum, publishes only the later of two prepares at the route’s size, and keeps it as the status loads', async () => {
    const { wallet, wrapper } = setup({ maxInputs: 25 })
    const statusRead = deferred<any>()
    wallet.getQbitConsolidationStatus
      .mockRejectedValueOnce({ message: 'HTTP 500' })
      .mockReturnValueOnce(statusRead.promise)
    const first = deferred<any>()
    const second = deferred<any>()
    wallet.createQbitConsolidationPsbt
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.canPrepare).toBe(true))

    act(() => {
      result.current.onClickPrepare()
    })
    act(() => {
      result.current.onClickPrepare()
    })
    const newer = batch('02', 25)
    await act(async () => {
      second.resolve(newer)
      await second.promise
    })
    expect(result.current.batch).toBe(newer)
    // The earlier request lands after the newer one, then the status read
    // the newer one started: neither replaces the newer batch.
    await act(async () => {
      first.resolve(batch('01', 25))
      await first.promise
    })
    expect(result.current.batch).toBe(newer)
    await act(async () => {
      statusRead.resolve(status)
      await statusRead.promise
    })
    expect(result.current.batchSizeText).toBe('25')
    expect(result.current.batch).toBe(newer)
    expect(
      wallet.createQbitConsolidationPsbt.mock.calls.map(([request]) => request.maxInputs)
    ).toEqual([25, 25])
  })

  it('keeps the size chosen through the confirm screen and Back, in its own route state', async () => {
    const { wallet, wrapper, navigation, store } = setup()
    const prepared = batch('10', 10)
    wallet.createQbitConsolidationPsbt.mockResolvedValue(prepared)
    const { result, unmount } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.canPrepare).toBe(true))

    act(() => {
      result.current.onBatchSizeChange('10')
    })
    act(() => {
      result.current.onClickPrepare()
    })
    await waitFor(() => expect(result.current.batch).toBe(prepared))
    act(() => {
      result.current.onClickConfirm()
    })

    // Written to this screen's own entry before the confirm screen is pushed
    // over it, for this account and network.
    const kept = {
      maxInputs: 10,
      chain: store.getState().settings.chainType,
      address: 'qb1ztestaccount',
    }
    expect(navigation.replace).toHaveBeenCalledWith('QbitConsolidationScreen', kept)
    expect(navigation.navigate).toHaveBeenCalledWith('TxConfirmScreen', { toSignData: prepared })
    expect(vi.mocked(navigation.replace).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(navigation.navigate).mock.invocationCallOrder[0]!
    )
    unmount()

    // Back from the confirm screen mounts the screen again with that state.
    const again = setup(vi.mocked(navigation.replace).mock.calls[0]![1])
    const { result: back } = renderHook(() => useQbitConsolidationScreenLogic(), {
      wrapper: again.wrapper,
    })
    await waitFor(() => expect(back.current.showBatchSize).toBe(true))
    expect(back.current.batchSizeText).toBe('10')
    expect(back.current.batchSize).toBe(10)
  })

  it('keeps the maximum, or the size a batch prepared without one records, through the confirm screen', async () => {
    // At the maximum.
    const atMax = setup()
    atMax.wallet.createQbitConsolidationPsbt.mockResolvedValue(batch('01'))
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), {
      wrapper: atMax.wrapper,
    })
    await waitFor(() => expect(result.current.canPrepare).toBe(true))
    act(() => {
      result.current.onClickPrepare()
    })
    await waitFor(() => expect(result.current.batch).toBeDefined())
    act(() => {
      result.current.onClickConfirm()
    })
    expect(atMax.navigation.replace).toHaveBeenCalledWith(
      'QbitConsolidationScreen',
      expect.objectContaining({ maxInputs: MAX_INPUT_COUNT })
    )

    // After a failed status read, with no size: the background's maximum.
    const unknown = setup()
    unknown.wallet.getQbitConsolidationStatus.mockRejectedValue({ message: 'HTTP 500' })
    unknown.wallet.createQbitConsolidationPsbt.mockResolvedValue(batch('02', MAX_INPUT_COUNT))
    const { result: failed } = renderHook(() => useQbitConsolidationScreenLogic(), {
      wrapper: unknown.wrapper,
    })
    await waitFor(() => expect(failed.current.canPrepare).toBe(true))
    act(() => {
      failed.current.onClickPrepare()
    })
    await waitFor(() => expect(failed.current.batch).toBeDefined())
    act(() => {
      failed.current.onClickConfirm()
    })
    expect(unknown.navigation.replace).toHaveBeenCalledWith(
      'QbitConsolidationScreen',
      expect.objectContaining({ maxInputs: MAX_INPUT_COUNT })
    )
  })

  it('opens at the maximum for another account or network than the size was kept for', async () => {
    const opened = async (routeState: any) => {
      const { wrapper } = setup(routeState)
      const { result, unmount } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
      await waitFor(() => expect(result.current.showBatchSize).toBe(true))
      const text = result.current.batchSizeText
      unmount()
      return text
    }
    const kept = { maxInputs: 10, chain: ChainType.QBIT_MAINNET, address: 'qb1ztestaccount' }

    expect(await opened(kept)).toBe('10')
    expect(await opened({ ...kept, address: 'qb1zother' })).toBe('106')
    expect(await opened({ ...kept, chain: ChainType.QBIT_TESTNET4 })).toBe('106')
    // Half an account is none.
    expect(await opened({ maxInputs: 10, address: 'qb1ztestaccount' })).toBe('106')
    expect(await opened({ maxInputs: 10, chain: ChainType.QBIT_MAINNET })).toBe('106')
    // A kept size is checked like any other.
    expect(await opened({ ...kept, maxInputs: 107 })).toBe('106')
    expect(await opened({ ...kept, maxInputs: '10' })).toBe('106')
  })

  it('applies a typed size only to the account and network it was typed for, and holds one', async () => {
    const { wrapper, store } = setup({
      maxInputs: 10,
      chain: ChainType.QBIT_MAINNET,
      address: 'qb1ztestaccount',
    })
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.batchSizeText).toBe('10'))
    act(() => {
      result.current.onBatchSizeChange('20')
    })
    const first = store.getState().accounts.current

    // Another account: neither the kept size nor the one typed applies.
    act(() => {
      store.dispatch(accountActions.setCurrent({ ...first, address: 'qb1zother' }))
    })
    expect(result.current.batchSizeText).not.toBe('20')
    await waitFor(() => expect(result.current.batchSizeText).toBe('106'))

    // Another network, likewise.
    act(() => {
      store.dispatch(accountActions.setCurrent(first))
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })
    await waitFor(() => expect(result.current.batchSizeText).toBe('106'))

    // Back on the first account and network, with no size typed elsewhere,
    // the one typed there applies again.
    act(() => {
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_MAINNET }))
    })
    await waitFor(() => expect(result.current.batchSizeText).toBe('20'))

    // One typed size, not one per account: a size typed for another account
    // replaces it, and the first opens at its opening size again.
    act(() => {
      store.dispatch(accountActions.setCurrent({ ...first, address: 'qb1zother' }))
    })
    await waitFor(() => expect(result.current.batchSizeText).toBe('106'))
    act(() => {
      result.current.onBatchSizeChange('30')
    })
    act(() => {
      store.dispatch(accountActions.setCurrent(first))
    })
    await waitFor(() => expect(result.current.batchSizeText).toBe('10'))
  })

  it('never publishes a prepare at the kept size for another account, two finishing out of order', async () => {
    const { wallet, wrapper, store } = setup({
      maxInputs: 10,
      chain: ChainType.QBIT_MAINNET,
      address: 'qb1ztestaccount',
    })
    const forFirst = deferred<any>()
    const forOther = deferred<any>()
    wallet.createQbitConsolidationPsbt
      .mockReturnValueOnce(forFirst.promise)
      .mockReturnValueOnce(forOther.promise)
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.canPrepare).toBe(true))
    expect(result.current.batchSizeText).toBe('10')

    act(() => {
      result.current.onClickPrepare()
    })
    act(() => {
      store.dispatch(
        accountActions.setCurrent({ ...store.getState().accounts.current, address: 'qb1zother' })
      )
    })
    await waitFor(() => expect(result.current.canPrepare).toBe(true))
    expect(result.current.batchSizeText).toBe('106')
    act(() => {
      result.current.onClickPrepare()
    })
    const forOtherBatch = batch('02')
    await act(async () => {
      forOther.resolve(forOtherBatch)
      await forOther.promise
    })
    await act(async () => {
      forFirst.resolve(batch('01', 10))
      await forFirst.promise
    })

    expect(result.current.batch).toBe(forOtherBatch)
    expect(
      wallet.createQbitConsolidationPsbt.mock.calls.map(([request]) => request.maxInputs)
    ).toEqual([10, MAX_INPUT_COUNT])
  })

  it('offers no batch size, range, fee preview or cost note for an account the explorer lists', async () => {
    const { wallet, wrapper } = setup({ maxInputs: 25 })
    wallet.getQbitConsolidationStatus.mockResolvedValue({
      ...status,
      confirmedUnspent: 300,
      pendingSpent: 0,
      pendingFunded: 0,
      overLimit: false,
      outputLimit: null,
    })
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.statusText).toBe('consolidation_within_limit'))

    expect(result.current.showBatchSize).toBe(false)
    expect(result.current.batchSizeRange).toBe('')
    expect(result.current.feePreview).toBe('')
    expect(result.current.costNote).toBe('')
    expect(result.current.canPrepare).toBe(false)
    // Nor a refusal for a size that is never offered.
    act(() => {
      result.current.onBatchSizeChange('1')
    })
    expect(result.current.batchSizeError).toBe('')

    // Refused by the explorer, it is offered whatever the count, below the
    // limit included (#169).
    for (const confirmedUnspent of [300, 812]) {
      const over = setup()
      over.wallet.getQbitConsolidationStatus.mockResolvedValue({ ...status, confirmedUnspent })
      const { result: shown, unmount } = renderHook(() => useQbitConsolidationScreenLogic(), {
        wrapper: over.wrapper,
      })
      await waitFor(() => expect(shown.current.showBatchSize).toBe(true))
      expect(shown.current.batchSizeRange).toBe('consolidation_batch_size_range:2|106')
      expect(shown.current.feePreview).toMatch(/^consolidation_fee_preview:106\|/)
      unmount()
    }
  })

  it('works without a batch shape: no fee preview or note, the size still applies', async () => {
    const { wallet, wrapper } = setup()
    const { batchShape: _omitted, ...withoutShape } = status
    wallet.getQbitConsolidationStatus.mockResolvedValue(withoutShape)
    wallet.createQbitConsolidationPsbt.mockResolvedValue(batch('01', 25))
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.canPrepare).toBe(true))

    act(() => {
      result.current.onBatchSizeChange('25')
    })
    expect(result.current.feePreview).toBe('')
    expect(result.current.costNote).toBe('')
    expect(result.current.statusText).toBe('consolidation_status:812|500')
    act(() => {
      result.current.onClickPrepare()
    })
    await waitFor(() => expect(result.current.batch).toBeDefined())
    expect(wallet.createQbitConsolidationPsbt).toHaveBeenCalledWith({
      feeRate: 2,
      enableRBF: true,
      maxInputs: 25,
    })
  })

  it('keeps the size for the next batch: confirm, success, then the consolidation screen', async () => {
    vi.useFakeTimers()
    const txid = 'cd'.repeat(32)
    const wallet = {
      ...createWalletMock(),
      broadcastQbitTx: vi.fn().mockResolvedValue({
        success: true,
        chain: ChainType.QBIT_MAINNET,
        txid,
        via: 'broadcast',
      }),
      releaseQbitSendBroadcastClaim: vi.fn().mockResolvedValue(true),
      abandonQbitSendBroadcastClaim: vi.fn().mockResolvedValue(undefined),
      getAddressBalanceV2: vi.fn().mockResolvedValue({
        availableBalance: 1,
        unavailableBalance: 0,
        totalBalance: 1,
        chainType: ChainType.QBIT_MAINNET,
      }),
    }

    // The confirm screen, after a batch of 25 went out.
    const confirmNavigation = createNavigationMock({ toSignData: batch('25', 25) })
    const confirm = createHookTestHarness({ wallet: wallet as any, navigation: confirmNavigation })
    const { result: confirmed } = renderHook(() => useTxConfirmScreenLogic(), {
      wrapper: confirm.wrapper,
    })
    await act(async () => {
      const done = confirmed.current.onClickConfirm([
        { psbtHex: '70736274ff25', qbitBroadcastIdentity: { chain: ChainType.QBIT_MAINNET, txid } },
      ])
      await vi.advanceTimersByTimeAsync(3000)
      await done
    })
    expect(confirmNavigation.replace).toHaveBeenCalledWith('TxSuccessScreen', {
      txid,
      consolidation: true,
      consolidationMaxInputs: 25,
    })
    vi.useRealTimers()

    // The success screen, with that route state.
    const successState = vi.mocked(confirmNavigation.replace).mock.calls[0]![1]
    const successNavigation = createNavigationMock(successState)
    const success = createHookTestHarness({ navigation: successNavigation })
    const { result: succeeded } = renderHook(() => useTxSuccessScreenLogic(), {
      wrapper: success.wrapper,
    })
    act(() => {
      succeeded.current.onClickContinueConsolidation()
    })
    expect(successNavigation.replace).toHaveBeenCalledWith('QbitConsolidationScreen', {
      maxInputs: 25,
    })

    // The consolidation screen opens at 25.
    const consolidationState = vi.mocked(successNavigation.replace).mock.calls[0]![1]
    const { wrapper } = setup(consolidationState)
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.showBatchSize).toBe(true))
    expect(result.current.batchSizeText).toBe('25')
    expect(result.current.batchSize).toBe(25)
  })

  it('keeps the size for the next batch when the batch succeeds through the failure screen', async () => {
    vi.useFakeTimers()
    const txid = 'cd'.repeat(32)
    const wallet = {
      ...createWalletMock(),
      // The broadcast's answer was lost; the status check then finds it.
      broadcastQbitTx: vi.fn().mockResolvedValue({
        success: false,
        chain: ChainType.QBIT_MAINNET,
        txid,
        outcome: 'unknown',
        reason: 'timeout',
        lookup: 'unavailable',
      }),
      checkQbitBroadcastStatus: vi.fn().mockResolvedValue({ found: true, txid, state: 'pending' }),
      releaseQbitSendBroadcastClaim: vi.fn().mockResolvedValue(true),
      abandonQbitSendBroadcastClaim: vi.fn().mockResolvedValue(undefined),
      getAddressBalanceV2: vi.fn().mockResolvedValue({
        availableBalance: 1,
        unavailableBalance: 0,
        totalBalance: 1,
        chainType: ChainType.QBIT_MAINNET,
      }),
    }

    // The confirm screen, for a batch of 25.
    const confirmNavigation = createNavigationMock({ toSignData: batch('25', 25) })
    const confirm = createHookTestHarness({ wallet: wallet as any, navigation: confirmNavigation })
    const { result: confirmed } = renderHook(() => useTxConfirmScreenLogic(), {
      wrapper: confirm.wrapper,
    })
    await act(async () => {
      await confirmed.current.onClickConfirm([
        { psbtHex: '70736274ff25', qbitBroadcastIdentity: { chain: ChainType.QBIT_MAINNET, txid } },
      ])
    })
    const [failRoute, failState] = vi.mocked(confirmNavigation.replace).mock.calls[0]!
    expect(failRoute).toBe('TxFailScreen')

    // The failure screen, whose status check finds the batch.
    const failNavigation = createNavigationMock(failState)
    const fail = createHookTestHarness({ wallet: wallet as any, navigation: failNavigation })
    const { result: failed } = renderHook(() => useTxFailScreenLogic(), { wrapper: fail.wrapper })
    await act(async () => {
      const check = failed.current.onClickCheckStatus()
      await vi.advanceTimersByTimeAsync(3000)
      await check
    })
    expect(failNavigation.replace).toHaveBeenCalledWith('TxSuccessScreen', {
      txid,
      consolidation: true,
      consolidationMaxInputs: 25,
    })
    vi.useRealTimers()

    // The success screen offers the next batch, at 25.
    const successNavigation = createNavigationMock(
      vi.mocked(failNavigation.replace).mock.calls[0]![1]
    )
    const success = createHookTestHarness({ navigation: successNavigation })
    const { result: succeeded } = renderHook(() => useTxSuccessScreenLogic(), {
      wrapper: success.wrapper,
    })
    expect(succeeded.current.consolidation).toBe(true)
    act(() => {
      succeeded.current.onClickContinueConsolidation()
    })
    const { wrapper } = setup(vi.mocked(successNavigation.replace).mock.calls[0]![1])
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.showBatchSize).toBe(true))
    expect(result.current.batchSizeText).toBe('25')
  })
})
