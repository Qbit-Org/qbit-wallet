import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

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
