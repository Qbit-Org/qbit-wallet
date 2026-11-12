import { ErrorCodes } from '@qbit/wallet-shared'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useCreatePasswordScreenLogic } from '../../src/ui-hooks/useCreatePasswordScreenLogic'
import { createHookTestHarness, createWalletMock } from './testHelpers'

function renderWithBoot(boot: () => Promise<unknown>) {
  const wallet = {
    ...createWalletMock(),
    boot: vi.fn(boot),
    getBiometricUnlockStatus: vi.fn().mockResolvedValue({ enrolled: false }),
  }
  const harness = createHookTestHarness({
    wallet: wallet as any,
    routeState: { isNewAccount: true },
  })
  const { result } = renderHook(() => useCreatePasswordScreenLogic({ offerBiometrics: false }), {
    wrapper: harness.wrapper,
  })
  return { ...harness, result }
}

describe('useCreatePasswordScreenLogic', () => {
  // A rejection crosses the UI port as a plain object; the toast renders its
  // argument as text, so it must get a string.
  it.each([
    [
      'the message of a refusal',
      { code: ErrorCodes.WALLET_RESET_INCOMPLETE, message: 'wallet_reset_incomplete' },
      'wallet_reset_incomplete',
    ],
    ['a generic message for a refusal without one', { code: -32603 }, 'unknown_error'],
    [
      'a generic message for a message that is no text',
      { message: { nested: true } },
      'unknown_error',
    ],
    ['a generic message for a rejection that is no object', undefined, 'unknown_error'],
  ])('shows %s when boot is refused', async (_name, rejection, shown) => {
    const { result, tools, navigation } = renderWithBoot(() => Promise.reject(rejection))

    await act(async () => {
      result.current.onClickConfirm()
    })

    expect(tools.toastError).toHaveBeenCalledTimes(1)
    expect(tools.toastError).toHaveBeenCalledWith(shown)
    expect(typeof vi.mocked(tools.toastError).mock.calls[0]![0]).toBe('string')
    expect(navigation.navigate).not.toHaveBeenCalled()
  })

  it('goes on to create the wallet once boot succeeds', async () => {
    const { result, tools, navigation } = renderWithBoot(() => Promise.resolve())

    await act(async () => {
      result.current.onClickConfirm()
    })

    expect(tools.toastError).not.toHaveBeenCalled()
    expect(navigation.navigate).toHaveBeenCalledWith('CreateHDWalletScreen', {
      isImport: false,
      fromUnlock: true,
    })
  })
})
