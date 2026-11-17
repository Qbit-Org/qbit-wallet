import { ErrorCodes } from '@qbit/wallet-shared'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { settingsActions } from '../../src/reducers'
import { useLockTimePageLogic } from '../../src/ui-hooks/useLockTimePageLogic'
import { createHookTestHarness, createWalletMock } from './testHelpers'

const { updateSettings } = settingsActions

describe('useLockTimePageLogic', () => {
  it('shows the error and stays on the page when the auto-lock time cannot be saved', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wallet = {
      ...createWalletMock(),
      setAutoLockTimeId: vi.fn().mockRejectedValue(new Error('QUOTA_BYTES quota exceeded')),
    }
    const { wrapper, tools, navigation, store } = createHookTestHarness({ wallet })
    const before = store.getState().settings.autoLockTimeId
    const { result } = renderHook(() => useLockTimePageLogic(), { wrapper })

    await act(async () => {
      await result.current.handleSelectOption({ id: 8, label: '15 minutes' })
    })

    expect(wallet.setAutoLockTimeId).toHaveBeenCalledWith(8)
    expect(tools.toastError).toHaveBeenCalledWith('QUOTA_BYTES quota exceeded')
    expect(tools.toastSuccess).not.toHaveBeenCalled()
    expect(navigation.goBack).not.toHaveBeenCalled()
    expect(store.getState().settings.autoLockTimeId).toBe(before)
    errorSpy.mockRestore()
  })

  it('says the stored setting may have changed when the previous lock time could not be saved again', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Errors reach the page over the port as plain objects.
    const wallet = {
      ...createWalletMock(),
      setAutoLockTimeId: vi.fn().mockRejectedValue({
        message: 'Failed to save autoLockTimeId, and its previous value could not be saved again',
        code: ErrorCodes.PREFERENCE_NOT_RESTORED,
      }),
    }
    const { wrapper, tools, navigation, store } = createHookTestHarness({ wallet })
    const before = store.getState().settings.autoLockTimeId
    const { result } = renderHook(() => useLockTimePageLogic(), { wrapper })

    await act(async () => {
      await result.current.handleSelectOption({ id: 8, label: '15 minutes' })
    })

    expect(tools.toastError).toHaveBeenCalledTimes(1)
    expect(tools.toastError).toHaveBeenCalledWith('setting_not_saved_may_have_changed')
    expect(tools.toastSuccess).not.toHaveBeenCalled()
    expect(navigation.goBack).not.toHaveBeenCalled()
    expect(store.getState().settings.autoLockTimeId).toBe(before)
    errorSpy.mockRestore()
  })

  it('shows the refusal and keeps the previous selection when the background refuses the time', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // A refusal reaches the page over the port as a plain object.
    const wallet = {
      ...createWalletMock(),
      setAutoLockTimeId: vi
        .fn()
        .mockRejectedValue({ message: 'Unknown auto-lock time', stack: '' }),
    }
    const { wrapper, tools, navigation, store } = createHookTestHarness({ wallet })
    store.dispatch(updateSettings({ autoLockTimeId: 6 }))
    const { result } = renderHook(() => useLockTimePageLogic(), { wrapper })

    await act(async () => {
      await result.current.handleSelectOption({ id: 4, label: '10 minutes' })
    })

    expect(tools.toastError).toHaveBeenCalledWith('Unknown auto-lock time')
    expect(tools.toastSuccess).not.toHaveBeenCalled()
    expect(navigation.goBack).not.toHaveBeenCalled()
    expect(store.getState().settings.autoLockTimeId).toBe(6)
    expect(result.current.autoLockTimeId).toBe(6)
    errorSpy.mockRestore()
  })

  it('offers the six times, shortest first', () => {
    const { wrapper } = createHookTestHarness()
    const { result } = renderHook(() => useLockTimePageLogic(), { wrapper })

    expect(result.current.autoLockTimes.map(option => option.id)).toEqual([3, 8, 5, 6, 9, 10])
    expect(result.current.autoLockTimeId).toBe(5)
  })

  // The option checked for each id an earlier, this or a later build stored.
  it.each([
    [0, 3],
    [1, 3],
    [2, 3],
    [3, 3],
    [4, 8],
    [5, 5],
    [6, 6],
    [7, 9],
    [8, 8],
    [9, 9],
    [10, 10],
    [11, 3],
  ])('checks the option for the stored id %s as %s', (stored, checked) => {
    const { wrapper, store } = createHookTestHarness()
    store.dispatch(updateSettings({ autoLockTimeId: stored }))
    const { result } = renderHook(() => useLockTimePageLogic(), { wrapper })

    expect(result.current.autoLockTimeId).toBe(checked)
    expect(result.current.autoLockTimes.filter(option => option.id === checked)).toHaveLength(1)
  })
})
