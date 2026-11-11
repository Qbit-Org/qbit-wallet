import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useTxSuccessScreenLogic } from '../../src/ui-hooks/useTxSuccessScreenLogic'
import { settingsActions } from '../../src/reducers/settings'
import { ChainType } from '@qbit/wallet-types'

import { createHookTestHarness, createNavigationMock, createToolsMock } from './testHelpers'

describe('useTxSuccessScreenLogic', () => {
  it('opens a configured explorer and falls back to copying on regtest', async () => {
    const txid = 'cd'.repeat(32)
    const navigation = createNavigationMock({ txid })
    const tools = createToolsMock()
    const { store, wrapper } = createHookTestHarness({ navigation, tools })
    const { result } = renderHook(() => useTxSuccessScreenLogic(), { wrapper })

    expect(result.current.txAction.type).toBe('explorer')

    act(() => {
      result.current.txAction.onClick()
    })
    expect(navigation.navToUrl).toHaveBeenCalledWith(
      `https://mempool.qbit.org/tx/${txid}`
    )

    act(() => {
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_REGTEST }))
    })
    await waitFor(() => {
      expect(result.current.txAction.type).toBe('copy')
    })

    act(() => {
      result.current.onClickExploreTx()
      result.current.txAction.onClick()
    })
    expect(navigation.navToUrl).toHaveBeenCalledTimes(1)
    expect(tools.copyToClipboard).toHaveBeenCalledWith(txid)
  })

  it('offers the next consolidation batch after one went out (#277)', () => {
    const txid = 'cd'.repeat(32)
    const navigation = createNavigationMock({ txid, consolidation: true })
    const { wrapper } = createHookTestHarness({ navigation })
    const { result } = renderHook(() => useTxSuccessScreenLogic(), { wrapper })

    expect(result.current.consolidation).toBe(true)
    act(() => {
      result.current.onClickContinueConsolidation()
    })
    expect(navigation.replace).toHaveBeenCalledWith('QbitConsolidationScreen')
  })

  it('offers the next batch at the size of the one that went out (#170)', () => {
    const txid = 'cd'.repeat(32)
    const navigation = createNavigationMock({
      txid,
      consolidation: true,
      consolidationMaxInputs: 25,
    })
    const { wrapper } = createHookTestHarness({ navigation })
    const { result } = renderHook(() => useTxSuccessScreenLogic(), { wrapper })

    act(() => {
      result.current.onClickContinueConsolidation()
    })
    // The consolidation screen checks the size against the account's maximum.
    expect(navigation.replace).toHaveBeenCalledWith('QbitConsolidationScreen', { maxInputs: 25 })
  })

  // Checked as the confirm and failure screens check the size they hand on.
  it.each([
    ['a numeric string', '25'],
    ['a fraction', 2.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['past the safe integers', 2 ** 53],
    ['null', null],
  ])('passes on no size that is %s (#170)', (_label, consolidationMaxInputs) => {
    const txid = 'cd'.repeat(32)
    const navigation = createNavigationMock({
      txid,
      consolidation: true,
      consolidationMaxInputs,
    })
    const { wrapper } = createHookTestHarness({ navigation })
    const { result } = renderHook(() => useTxSuccessScreenLogic(), { wrapper })

    act(() => {
      result.current.onClickContinueConsolidation()
    })
    expect(navigation.replace).toHaveBeenCalledWith('QbitConsolidationScreen')
    expect(vi.mocked(navigation.replace).mock.calls[0]).toHaveLength(1)
  })

  it('falls back to a safe copy action when route state is missing', () => {
    const navigation = createNavigationMock({})
    const tools = createToolsMock()
    const { wrapper } = createHookTestHarness({ navigation, tools })
    const { result } = renderHook(() => useTxSuccessScreenLogic(), { wrapper })

    expect(result.current.txid).toBe('')
    expect(result.current.consolidation).toBe(false)
    expect(result.current.txAction.type).toBe('copy')

    act(() => {
      result.current.onClickExploreTx()
      result.current.txAction.onClick()
    })
    expect(navigation.navToUrl).not.toHaveBeenCalled()
    expect(tools.copyToClipboard).toHaveBeenCalledWith('')
  })
})
