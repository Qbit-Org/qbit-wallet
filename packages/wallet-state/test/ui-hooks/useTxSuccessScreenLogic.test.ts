import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode, createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { useTxSuccessScreenLogic } from '../../src/ui-hooks/useTxSuccessScreenLogic'
import { WalletProvider } from '../../src/context/WalletContext'
import { settingsActions } from '../../src/reducers/settings'
import { ChainType } from '@qbit/wallet-types'

import {
  createHookTestHarness,
  createNavigationMock,
  createToolsMock,
  createWalletMock,
} from './testHelpers'

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

  it('removes a completed send plan from the home screen once the user leaves (#188)', async () => {
    const navigation = createNavigationMock({ txid: 'cd'.repeat(32), sendPlanId: 'plan-1' })
    const harness = createHookTestHarness({ navigation })
    const { result, unmount } = renderHook(() => useTxSuccessScreenLogic(), {
      wrapper: harness.wrapper,
    })

    act(() => {
      result.current.onClickDone()
    })
    expect(navigation.navigate).toHaveBeenCalledWith('MainScreen')
    // Leaving is what removes it, whichever way the user leaves.
    expect(harness.wallet.dismissQbitSendPlan).not.toHaveBeenCalled()
    unmount()
    await waitFor(() => expect(harness.wallet.dismissQbitSendPlan).toHaveBeenCalledWith('plan-1'))
    expect(harness.wallet.dismissQbitSendPlan).toHaveBeenCalledTimes(1)
  })

  it('keeps the plan while the screen shows, through React running its effect twice (#188)', async () => {
    const navigation = createNavigationMock({ txid: 'cd'.repeat(32), sendPlanId: 'plan-1' })
    const harness = createHookTestHarness({ navigation })
    // Development builds mount, unmount and mount again under StrictMode.
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(StrictMode, null, createElement(harness.wrapper, { children }))
    const { unmount } = renderHook(() => useTxSuccessScreenLogic(), { wrapper })

    await act(async () => {})
    expect(harness.wallet.dismissQbitSendPlan).not.toHaveBeenCalled()
    unmount()
    await waitFor(() => expect(harness.wallet.dismissQbitSendPlan).toHaveBeenCalledWith('plan-1'))
    expect(harness.wallet.dismissQbitSendPlan).toHaveBeenCalledTimes(1)
  })

  it('keeps the plan while the screen shows, when the wallet object changes (#188)', async () => {
    const navigation = createNavigationMock({ txid: 'cd'.repeat(32), sendPlanId: 'plan-1' })
    const harness = createHookTestHarness({ navigation })
    const replacement = createWalletMock()
    let wallet = harness.wallet
    // The harness's providers, with the wallet object the test chooses.
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        harness.wrapper,
        null,
        createElement(WalletProvider, { wallet: wallet as any }, children)
      )
    const { rerender, unmount } = renderHook(() => useTxSuccessScreenLogic(), { wrapper })

    wallet = replacement
    rerender()
    await act(async () => {})
    expect(harness.wallet.dismissQbitSendPlan).not.toHaveBeenCalled()
    expect(replacement.dismissQbitSendPlan).not.toHaveBeenCalled()

    unmount()
    await waitFor(() => expect(replacement.dismissQbitSendPlan).toHaveBeenCalledWith('plan-1'))
    expect(replacement.dismissQbitSendPlan).toHaveBeenCalledTimes(1)
    expect(harness.wallet.dismissQbitSendPlan).not.toHaveBeenCalled()
  })

  it('leaves quietly when the background refuses to remove the plan (#188)', async () => {
    const navigation = createNavigationMock({ txid: 'cd'.repeat(32), sendPlanId: 'plan-1' })
    const harness = createHookTestHarness({ navigation })
    harness.wallet.dismissQbitSendPlan.mockRejectedValue({ message: 'The plan is not finished.' })
    const { unmount } = renderHook(() => useTxSuccessScreenLogic(), { wrapper: harness.wrapper })

    unmount()
    await waitFor(() => expect(harness.wallet.dismissQbitSendPlan).toHaveBeenCalledTimes(1))
  })

  it('removes no plan after an ordinary send', () => {
    const navigation = createNavigationMock({ txid: 'cd'.repeat(32) })
    const harness = createHookTestHarness({ navigation })
    const { unmount } = renderHook(() => useTxSuccessScreenLogic(), { wrapper: harness.wrapper })
    unmount()
    expect(harness.wallet.dismissQbitSendPlan).not.toHaveBeenCalled()
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
