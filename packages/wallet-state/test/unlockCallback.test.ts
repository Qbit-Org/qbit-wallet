import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { ErrorCodes } from '@qbit/wallet-shared'

import { useUnlockCallback } from '../src/hooks/global'
import { useBiometricUnlock } from '../src/ui-hooks/useBiometricUnlock'
import { createHookTestHarness, createWalletMock } from './ui-hooks/testHelpers'

const biometric = vi.hoisted(() => ({
  isBiometricUnlockSupported: vi.fn(),
  unwrapBiometricPassword: vi.fn(),
}))

vi.mock('../src/biometric', () => ({
  ...biometric,
  BiometricEnrollmentIncompleteError: class extends Error {},
  BiometricPrfUnsupportedError: class extends Error {},
  BiometricUnwrapFailedError: class extends Error {},
  enrollBiometricUnlock: vi.fn(),
  rewrapBiometricPassword: vi.fn(),
}))

function setup(unlock = vi.fn().mockResolvedValue(undefined)) {
  const wallet = {
    ...createWalletMock(),
    unlock,
    resolveUnlockApproval: vi.fn().mockResolvedValue(true),
    getBiometricUnlockStatus: vi.fn().mockResolvedValue({ enrolled: true }),
    getBiometricUnlockRecord: vi.fn().mockResolvedValue({ version: 1 }),
    verifyPassword: vi.fn().mockResolvedValue(true),
    clearBiometricUnlock: vi.fn().mockResolvedValue(undefined),
  }
  const harness = createHookTestHarness({ wallet })
  return { ...harness, wallet }
}

// Resolving through the approval context would act on whatever approval is
// pending; the unlock must only ever reach the background's unlock-only resolve.
function expectApprovalContextUntouched(
  approval: ReturnType<typeof setup>['approval'],
  navigation: ReturnType<typeof setup>['navigation']
) {
  expect(approval.getApproval).not.toHaveBeenCalled()
  expect(approval.resolveApproval).not.toHaveBeenCalled()
  expect(approval.rejectApproval).not.toHaveBeenCalled()
  expect(navigation.navToRootHome).not.toHaveBeenCalled()
}

describe('useUnlockCallback approval handling', () => {
  it('asks the background to resolve only the unlock request once the wallet unlocks', async () => {
    const { wrapper, approval, navigation, store, wallet } = setup()
    const { result } = renderHook(() => useUnlockCallback(), { wrapper })

    await act(async () => {
      await result.current('password')
    })

    expect(wallet.unlock).toHaveBeenCalledWith('password')
    expect(store.getState().global.isUnlocked).toBe(true)
    expect(wallet.resolveUnlockApproval).toHaveBeenCalledOnce()
    expect(wallet.unlock.mock.invocationCallOrder[0]).toBeLessThan(
      wallet.resolveUnlockApproval.mock.invocationCallOrder[0]
    )
    expectApprovalContextUntouched(approval, navigation)
  })

  it('returns only after the background has answered', async () => {
    const { wrapper, wallet } = setup()
    let answer!: (resolved: boolean) => void
    wallet.resolveUnlockApproval.mockImplementation(
      () =>
        new Promise<boolean>(resolve => {
          answer = resolve
        })
    )
    const { result } = renderHook(() => useUnlockCallback(), { wrapper })

    let settled = false
    await act(async () => {
      result.current('password').then(() => {
        settled = true
      })
      await vi.waitFor(() => expect(wallet.resolveUnlockApproval).toHaveBeenCalledOnce())
    })
    expect(settled).toBe(false)

    await act(async () => {
      answer(false)
    })
    expect(settled).toBe(true)
  })

  it('does not throw when the background call fails', async () => {
    const { wrapper, approval, navigation, store, wallet } = setup()
    wallet.resolveUnlockApproval.mockRejectedValue(new Error('port disconnected'))
    const { result } = renderHook(() => useUnlockCallback(), { wrapper })

    await act(async () => {
      await result.current('password')
    })

    expect(store.getState().global.isUnlocked).toBe(true)
    expectApprovalContextUntouched(approval, navigation)
  })

  it('touches no approval when the password is wrong', async () => {
    const { wrapper, approval, navigation, store, wallet } = setup(
      vi.fn().mockRejectedValue(new Error('invalid password'))
    )
    const { result } = renderHook(() => useUnlockCallback(), { wrapper })

    await act(async () => {
      await expect(result.current('wrong')).rejects.toThrow('invalid password')
    })

    expect(store.getState().global.isUnlocked).toBe(false)
    expect(wallet.resolveUnlockApproval).not.toHaveBeenCalled()
    expectApprovalContextUntouched(approval, navigation)
  })
})

describe('useUnlockCallback when the wallet locks during the unlock', () => {
  it('leaves the wallet shown as locked and rejects with the reason', async () => {
    // Errors reach the page over the port as plain objects.
    const lockedDuringUnlock = {
      message: 'The wallet locked while unlocking. Unlock it again.',
      code: ErrorCodes.WALLET_LOCKED_DURING_UNLOCK,
    }
    const { wrapper, approval, navigation, store, wallet } = setup(
      vi.fn().mockRejectedValue(lockedDuringUnlock)
    )
    const { result } = renderHook(() => useUnlockCallback(), { wrapper })

    await act(async () => {
      await expect(result.current('password')).rejects.toBe(lockedDuringUnlock)
    })

    // No main screen: the store still reads locked, and no unlock request is
    // answered for a wallet that is locked.
    expect(store.getState().global.isUnlocked).toBe(false)
    expect(wallet.resolveUnlockApproval).not.toHaveBeenCalled()
    expectApprovalContextUntouched(approval, navigation)
  })
})

// After a reset of unknown outcome the background refuses every unlock until
// it starts again; the page must get that refusal as it came.
describe('a reset of unknown outcome', () => {
  const outcomeUnknown = {
    code: ErrorCodes.WALLET_RESET_OUTCOME_UNKNOWN,
    message:
      'The reset could not be finished. Restart your browser, then open Qbit Wallet to check.',
  }

  it('rejects the unlock with the refusal as it came, and leaves the wallet shown as locked', async () => {
    const { wrapper, approval, navigation, store, wallet } = setup(
      vi.fn().mockRejectedValue(outcomeUnknown)
    )
    const { result } = renderHook(() => useUnlockCallback(), { wrapper })

    await act(async () => {
      await expect(result.current('password')).rejects.toBe(outcomeUnknown)
    })

    expect(store.getState().global.isUnlocked).toBe(false)
    expect(wallet.resolveUnlockApproval).not.toHaveBeenCalled()
    expectApprovalContextUntouched(approval, navigation)
  })

  it('rejects a TouchID unlock with it too, keeping the record, which is not stale', async () => {
    biometric.isBiometricUnlockSupported.mockResolvedValue(true)
    biometric.unwrapBiometricPassword.mockResolvedValue('password')
    const { wrapper, wallet } = setup(vi.fn().mockRejectedValue(outcomeUnknown))
    const { result } = renderHook(() => useBiometricUnlock(), { wrapper })

    await act(async () => {
      await expect(result.current.unlockWithBiometric()).rejects.toBe(outcomeUnknown)
    })

    expect(wallet.clearBiometricUnlock).not.toHaveBeenCalled()
  })
})

describe('useBiometricUnlock approval handling', () => {
  it('asks the background to resolve only the unlock request after a TouchID unlock', async () => {
    biometric.isBiometricUnlockSupported.mockResolvedValue(true)
    biometric.unwrapBiometricPassword.mockResolvedValue('password')
    const { wrapper, approval, navigation, wallet } = setup()
    const { result } = renderHook(() => useBiometricUnlock(), { wrapper })

    await act(async () => {
      await result.current.unlockWithBiometric()
    })

    expect(wallet.unlock).toHaveBeenCalledWith('password')
    expect(wallet.resolveUnlockApproval).toHaveBeenCalledOnce()
    expectApprovalContextUntouched(approval, navigation)
  })
})
