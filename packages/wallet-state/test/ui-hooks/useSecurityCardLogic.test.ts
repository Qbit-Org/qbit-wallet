import { ErrorCodes } from '@qbit/wallet-shared'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSecurityCardLogic } from '../../src/ui-hooks/useSecurityCardLogic'
import { createHookTestHarness, createWalletMock } from './testHelpers'

function walletWithLockSettings(stored = { computer: true, windows: true }) {
  return {
    ...createWalletMock(),
    getLockOnComputerLock: vi.fn().mockResolvedValue(stored.computer),
    getLockOnWindowsClosed: vi.fn().mockResolvedValue(stored.windows),
    setLockOnComputerLock: vi.fn().mockResolvedValue(undefined),
    setLockOnWindowsClosed: vi.fn().mockResolvedValue(undefined),
  }
}

async function renderLoaded(wallet: ReturnType<typeof walletWithLockSettings>) {
  const harness = createHookTestHarness({ wallet })
  const rendered = renderHook(() => useSecurityCardLogic(), { wrapper: harness.wrapper })
  await waitFor(() => expect(rendered.result.current.lockOnComputerLock).not.toBeUndefined())
  return { ...harness, ...rendered }
}

describe('useSecurityCardLogic', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('shows both settings as the wallet stores them, and nothing before they are read', async () => {
    const wallet = walletWithLockSettings({ computer: true, windows: false })
    const harness = createHookTestHarness({ wallet })
    const { result } = renderHook(() => useSecurityCardLogic(), { wrapper: harness.wrapper })
    expect(result.current.lockOnComputerLock).toBeUndefined()
    expect(result.current.lockOnWindowsClosed).toBeUndefined()

    await waitFor(() => expect(result.current.lockOnComputerLock).toBe(true))
    expect(result.current.lockOnWindowsClosed).toBe(false)
  })

  it('saves each setting through its own method', async () => {
    const wallet = walletWithLockSettings()
    const { result } = await renderLoaded(wallet)

    await act(async () => {
      await result.current.changeLockOnComputerLock(false)
    })
    expect(wallet.setLockOnComputerLock).toHaveBeenCalledWith(false)
    expect(result.current.lockOnComputerLock).toBe(false)
    expect(result.current.lockOnWindowsClosed).toBe(true)

    await act(async () => {
      await result.current.changeLockOnWindowsClosed(false)
    })
    expect(wallet.setLockOnWindowsClosed).toHaveBeenCalledWith(false)
    expect(result.current.lockOnWindowsClosed).toBe(false)
  })

  it('keeps the switch and shows the error when the change cannot be saved', async () => {
    const wallet = walletWithLockSettings()
    wallet.setLockOnComputerLock.mockRejectedValue(new Error('QUOTA_BYTES quota exceeded'))
    const { result, tools } = await renderLoaded(wallet)

    await act(async () => {
      await result.current.changeLockOnComputerLock(false)
    })
    expect(tools.toastError).toHaveBeenCalledWith('QUOTA_BYTES quota exceeded')
    expect(result.current.lockOnComputerLock).toBe(true)
    expect(result.current.saving).toBe(false)
  })

  it('says the stored setting may have changed when the previous value could not be saved again', async () => {
    const wallet = walletWithLockSettings()
    // Errors reach the page over the port as plain objects.
    wallet.setLockOnWindowsClosed.mockRejectedValue({
      message: 'Failed to save lockOnWindowsClosed, and its previous value could not be saved again',
      code: ErrorCodes.PREFERENCE_NOT_RESTORED,
    })
    const { result, tools } = await renderLoaded(wallet)

    await act(async () => {
      await result.current.changeLockOnWindowsClosed(false)
    })
    expect(tools.toastError).toHaveBeenCalledTimes(1)
    expect(tools.toastError).toHaveBeenCalledWith('setting_not_saved_may_have_changed')
    expect(result.current.lockOnWindowsClosed).toBe(true)
  })

  it('saves one change at a time, so an earlier one cannot land after a newer one', async () => {
    const wallet = walletWithLockSettings()
    let finishFirst: () => void = () => undefined
    wallet.setLockOnComputerLock.mockReturnValueOnce(new Promise<void>(resolve => (finishFirst = resolve)))
    const { result } = await renderLoaded(wallet)

    let first: Promise<void> | undefined
    act(() => {
      first = result.current.changeLockOnComputerLock(false)
    })
    expect(result.current.saving).toBe(true)
    // A second click while the first saves is ignored, on either switch.
    await act(async () => {
      await result.current.changeLockOnComputerLock(true)
      await result.current.changeLockOnWindowsClosed(false)
    })
    expect(wallet.setLockOnComputerLock).toHaveBeenCalledTimes(1)
    expect(wallet.setLockOnWindowsClosed).not.toHaveBeenCalled()

    await act(async () => {
      finishFirst()
      await first
    })
    expect(result.current.lockOnComputerLock).toBe(false)
    expect(result.current.saving).toBe(false)
  })

  it('changes nothing before the settings are read', async () => {
    const wallet = walletWithLockSettings()
    wallet.getLockOnComputerLock.mockReturnValue(new Promise(() => undefined))
    const harness = createHookTestHarness({ wallet })
    const { result } = renderHook(() => useSecurityCardLogic(), { wrapper: harness.wrapper })

    await act(async () => {
      await result.current.changeLockOnComputerLock(false)
    })
    expect(wallet.setLockOnComputerLock).not.toHaveBeenCalled()
  })
})
