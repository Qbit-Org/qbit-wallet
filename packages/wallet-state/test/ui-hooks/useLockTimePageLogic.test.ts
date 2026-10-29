import { ErrorCodes } from '@qbit/wallet-shared'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useLockTimePageLogic } from '../../src/ui-hooks/useLockTimePageLogic'
import { createHookTestHarness, createWalletMock } from './testHelpers'

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
      await result.current.handleSelectOption({ id: 1, label: '1 minute' })
    })

    expect(wallet.setAutoLockTimeId).toHaveBeenCalledWith(1)
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
      await result.current.handleSelectOption({ id: 1, label: '1 minute' })
    })

    expect(tools.toastError).toHaveBeenCalledTimes(1)
    expect(tools.toastError).toHaveBeenCalledWith('setting_not_saved_may_have_changed')
    expect(tools.toastSuccess).not.toHaveBeenCalled()
    expect(navigation.goBack).not.toHaveBeenCalled()
    expect(store.getState().settings.autoLockTimeId).toBe(before)
    errorSpy.mockRestore()
  })
})
