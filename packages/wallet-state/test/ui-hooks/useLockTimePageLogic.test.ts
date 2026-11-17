import { ErrorCodes } from '@qbit/wallet-shared'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { settingsActions } from '../../src/reducers'
import {
  LOCK_TIME_LEAVE_DELAY_MS,
  useLockTimePageLogic,
} from '../../src/ui-hooks/useLockTimePageLogic'
import { createHookTestHarness, createWalletMock } from './testHelpers'

const { updateSettings } = settingsActions

const FIVE_MINUTES = { id: 3, label: '5 minutes' }
const FIFTEEN_MINUTES = { id: 8, label: '15 minutes' }

/** A wallet whose save succeeds. */
function walletThatSaves() {
  return { ...createWalletMock(), setAutoLockTimeId: vi.fn().mockResolvedValue(undefined) }
}

/** The hook with fake timers and a `leave` of its own, as the extension's screen passes one. */
function renderWithLeave(wallet: ReturnType<typeof createWalletMock> = walletThatSaves()) {
  vi.useFakeTimers()
  const leave = vi.fn()
  const harness = createHookTestHarness({ wallet })
  const view = renderHook(() => useLockTimePageLogic({ leave }), { wrapper: harness.wrapper })
  return { ...harness, ...view, leave }
}

/** A wallet whose save answers only when the test says so. */
function walletWithHeldSave() {
  let answer: () => void = () => {}
  const wallet = {
    ...createWalletMock(),
    setAutoLockTimeId: vi.fn(
      () =>
        new Promise<void>(resolve => {
          answer = resolve
        })
    ),
  }
  return { wallet, answerSave: () => answer() }
}

describe('useLockTimePageLogic', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('leaving after a save', () => {
    it('leaves once, after the chosen time has been in view a moment', async () => {
      const { result, leave, navigation, store } = renderWithLeave()

      await act(async () => {
        await result.current.handleSelectOption(FIVE_MINUTES)
      })
      expect(store.getState().settings.autoLockTimeId).toBe(3)
      expect(leave).not.toHaveBeenCalled()

      act(() => {
        vi.advanceTimersByTime(LOCK_TIME_LEAVE_DELAY_MS - 1)
      })
      expect(leave).not.toHaveBeenCalled()

      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(leave).toHaveBeenCalledTimes(1)
      // The screen's own leave, not plain history Back.
      expect(navigation.goBack).not.toHaveBeenCalled()

      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      expect(leave).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('goes back in history when the screen names no way to leave', async () => {
      vi.useFakeTimers()
      const { wrapper, navigation } = createHookTestHarness({ wallet: walletThatSaves() })
      const { result } = renderHook(() => useLockTimePageLogic(), { wrapper })

      await act(async () => {
        await result.current.handleSelectOption(FIVE_MINUTES)
      })
      act(() => {
        vi.advanceTimersByTime(LOCK_TIME_LEAVE_DELAY_MS)
      })

      expect(navigation.goBack).toHaveBeenCalledTimes(1)
    })

    it('leaves once when another time is chosen while the leave waits', async () => {
      const { result, leave, wallet, store } = renderWithLeave()

      await act(async () => {
        await result.current.handleSelectOption(FIVE_MINUTES)
      })
      act(() => {
        vi.advanceTimersByTime(100)
      })
      await act(async () => {
        await result.current.handleSelectOption(FIFTEEN_MINUTES)
      })
      act(() => {
        vi.advanceTimersByTime(10_000)
      })

      expect(wallet.setAutoLockTimeId).toHaveBeenCalledTimes(2)
      expect(store.getState().settings.autoLockTimeId).toBe(8)
      expect(leave).toHaveBeenCalledTimes(1)
    })

    it('is not followed by a second leave when Back is pressed while it waits', async () => {
      const { result, leave } = renderWithLeave()

      await act(async () => {
        await result.current.handleSelectOption(FIVE_MINUTES)
      })
      act(() => {
        vi.advanceTimersByTime(100)
      })

      act(() => {
        result.current.goBack()
      })
      expect(leave).toHaveBeenCalledTimes(1)

      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      expect(leave).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('does not leave once the screen has gone', async () => {
      const { result, leave, unmount } = renderWithLeave()

      await act(async () => {
        await result.current.handleSelectOption(FIVE_MINUTES)
      })
      act(() => {
        vi.advanceTimersByTime(100)
      })
      unmount()

      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(10_000)
      expect(leave).not.toHaveBeenCalled()
    })

    it('does not leave when Back was pressed before the save answered', async () => {
      const { wallet, answerSave } = walletWithHeldSave()
      const { result, leave, store } = renderWithLeave(wallet)

      let saved: Promise<void> | undefined
      act(() => {
        saved = result.current.handleSelectOption(FIVE_MINUTES)
      })
      act(() => {
        result.current.goBack()
      })
      expect(leave).toHaveBeenCalledTimes(1)

      await act(async () => {
        answerSave()
        await saved
      })
      act(() => {
        vi.advanceTimersByTime(10_000)
      })

      // Saved all the same, and not left a second time.
      expect(store.getState().settings.autoLockTimeId).toBe(3)
      expect(leave).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('does not leave when the screen went before the save answered', async () => {
      const { wallet, answerSave } = walletWithHeldSave()
      const { result, leave, unmount } = renderWithLeave(wallet)

      let saved: Promise<void> | undefined
      act(() => {
        saved = result.current.handleSelectOption(FIVE_MINUTES)
      })
      unmount()

      await act(async () => {
        answerSave()
        await saved
      })
      vi.advanceTimersByTime(10_000)

      expect(vi.getTimerCount()).toBe(0)
      expect(leave).not.toHaveBeenCalled()
    })

    // The screen goes once it has left, but not at once: until it does, a
    // save that answers late, or another time chosen, does not leave again.
    it('does not leave again for a save that answers after the screen left', async () => {
      let answerSecond: () => void = () => {}
      const wallet = {
        ...createWalletMock(),
        setAutoLockTimeId: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockImplementationOnce(
            () =>
              new Promise<void>(resolve => {
                answerSecond = resolve
              })
          ),
      }
      const { result, leave, store } = renderWithLeave(wallet)

      await act(async () => {
        await result.current.handleSelectOption(FIVE_MINUTES)
      })
      act(() => {
        vi.advanceTimersByTime(100)
      })
      // Another time, whose save answers only after the screen has left.
      let saved: Promise<void> | undefined
      act(() => {
        saved = result.current.handleSelectOption(FIFTEEN_MINUTES)
      })
      act(() => {
        vi.advanceTimersByTime(LOCK_TIME_LEAVE_DELAY_MS)
      })
      expect(leave).toHaveBeenCalledTimes(1)

      await act(async () => {
        answerSecond()
        await saved
      })
      act(() => {
        vi.advanceTimersByTime(10_000)
      })

      expect(store.getState().settings.autoLockTimeId).toBe(8)
      expect(leave).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('does not leave again for a time chosen after the screen left', async () => {
      const { result, leave, wallet } = renderWithLeave()

      await act(async () => {
        await result.current.handleSelectOption(FIVE_MINUTES)
      })
      act(() => {
        vi.advanceTimersByTime(LOCK_TIME_LEAVE_DELAY_MS)
      })
      expect(leave).toHaveBeenCalledTimes(1)

      await act(async () => {
        await result.current.handleSelectOption(FIFTEEN_MINUTES)
      })
      act(() => {
        vi.advanceTimersByTime(10_000)
      })

      expect(wallet.setAutoLockTimeId).toHaveBeenCalledTimes(2)
      expect(leave).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  it('leaves at once on Back, by the way the screen names', () => {
    const { result, leave, navigation } = renderWithLeave()

    act(() => {
      result.current.goBack()
    })

    expect(leave).toHaveBeenCalledTimes(1)
    expect(navigation.goBack).not.toHaveBeenCalled()
  })

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

  it('stays on the screen, with no leave waiting, when the save fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wallet = {
      ...createWalletMock(),
      setAutoLockTimeId: vi.fn().mockRejectedValue({ message: 'QUOTA_BYTES quota exceeded' }),
    }
    const { result, leave, tools, navigation } = renderWithLeave(wallet)

    await act(async () => {
      await result.current.handleSelectOption(FIVE_MINUTES)
    })
    expect(vi.getTimerCount()).toBe(0)
    act(() => {
      vi.advanceTimersByTime(10_000)
    })

    expect(tools.toastError).toHaveBeenCalledWith('QUOTA_BYTES quota exceeded')
    expect(leave).not.toHaveBeenCalled()
    expect(navigation.goBack).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)
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
