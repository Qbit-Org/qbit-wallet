import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ChainType } from '@qbit/wallet-types'

import { I18nContext } from '../../src/context/I18nContext'
import { accountActions } from '../../src/reducers/accounts'
import { uiActions } from '../../src/reducers/ui'
import { useQbitConsolidationScreenLogic } from '../../src/ui-hooks/useQbitConsolidationScreenLogic'
import { createHookTestHarness, createWalletMock } from './testHelpers'

const status = {
  chain: ChainType.QBIT_MAINNET,
  address: 'qb1ztestaccount',
  confirmedUnspent: 812,
  pendingSpent: 106,
  pendingFunded: 1,
  outputLimit: 500,
  maxInputCount: 106,
}

function batch(seed: string) {
  return {
    psbtHex: `70736274ff${seed}`,
    toSignInputs: [],
    inputCount: 106,
    estimatedFee: 398_870,
    estimatedVsize: 398_870,
    qbitConsolidation: {
      confirmedOutputCount: 812,
      outputLimit: 500,
      amount: 5_000_000,
      fundingOutputCounts: Array(106).fill(2),
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => {
    resolve = settle
  })
  return { promise, resolve }
}

function setup() {
  const wallet = {
    ...createWalletMock(),
    getQbitConsolidationStatus: vi.fn().mockResolvedValue(status),
    createQbitConsolidationPsbt: vi.fn(),
  }
  const harness = createHookTestHarness({ wallet: wallet as any })
  harness.store.dispatch(uiActions.updateFeeRateBar({ feeRate: 2 }))
  const t = vi.fn((key: string, substitutions?: string | string[]) =>
    substitutions ? `${key}:${[substitutions].flat().join('|')}` : key
  )
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
      createElement(harness.wrapper, { children })
    )
  return { ...harness, wallet, wrapper, t }
}

describe('useQbitConsolidationScreenLogic (#277)', () => {
  it('shows where the account stands and previews one batch before the confirm screen', async () => {
    const { wallet, wrapper, navigation } = setup()
    const prepared = batch('01')
    wallet.createQbitConsolidationPsbt.mockResolvedValue(prepared)
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })

    // 812 confirmed outputs; once the pending batch confirms, 707 remain,
    // two more batches of 105 net each.
    await waitFor(() => {
      expect(result.current.statusText).toBe('consolidation_status:812|500|2')
    })
    expect(result.current.pendingText).toBe('consolidation_pending:106')
    expect(result.current.description).toBe('consolidation_description:106')
    expect(result.current.canPrepare).toBe(true)

    act(() => {
      result.current.onClickPrepare()
    })
    await waitFor(() => {
      expect(result.current.batch).toBe(prepared)
    })
    expect(wallet.createQbitConsolidationPsbt).toHaveBeenCalledWith({ feeRate: 2, enableRBF: true })
    expect(result.current.batchSummary).toBe(
      'consolidation_batch_summary:106|0.05000000|QBT|398870|398.9'
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

  it('says when the pending batches already bring the account within the limit', async () => {
    const { wallet, wrapper } = setup()
    wallet.getQbitConsolidationStatus.mockResolvedValue({
      ...status,
      confirmedUnspent: 560,
      pendingSpent: 106,
    })
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })

    await waitFor(() => {
      expect(result.current.statusText).toBe('consolidation_status_confirming:560|500')
    })
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
    await waitFor(() => expect(result.current.statusText).toBe('consolidation_status:812|500|2'))
    expect(result.current.error).toBe('')
  })

  it('offers nothing to do for an account within the limit', async () => {
    const { wallet, wrapper } = setup()
    wallet.getQbitConsolidationStatus.mockResolvedValue({
      ...status,
      confirmedUnspent: 300,
      pendingSpent: 0,
    })
    const { result } = renderHook(() => useQbitConsolidationScreenLogic(), { wrapper })

    await waitFor(() => {
      expect(result.current.statusText).toBe('consolidation_within_limit:500')
    })
    expect(result.current.canPrepare).toBe(false)
  })
})
