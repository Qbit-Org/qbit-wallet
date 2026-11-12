import { KeyringType, type Account } from '@qbit/wallet-shared'
import { act, renderHook } from '@testing-library/react'
import type { KeyboardEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { useExportPrivateKeyScreenLogic } from '../../src/ui-hooks/useExportPrivateKeyScreenLogic'
import { createHookTestHarness, createWalletMock } from './testHelpers'

const PASSWORD = 'wallet password'

const account: Account = {
  type: KeyringType.HdKeyring,
  pubkey: '02ab',
  address: 'qb1zexample',
  key: 'keyring_2#0',
  flag: 0,
}

/** A keydown in the password field, as the field hands it to the screen logic. */
function keyDown(key: string, { repeat = false, isComposing = false } = {}) {
  return { key, repeat, nativeEvent: { isComposing } } as unknown as KeyboardEvent<HTMLInputElement>
}

function renderWithPassword() {
  // As for a wrong password: the background refuses it.
  const getPrivateKey = vi.fn().mockRejectedValue({ message: 'Password is incorrect' })
  const wallet = { ...createWalletMock(), getPrivateKey }
  const harness = createHookTestHarness({ wallet, routeState: { account } })
  const { result } = renderHook(() => useExportPrivateKeyScreenLogic(), {
    wrapper: harness.wrapper,
  })
  act(() => result.current.setPassword(PASSWORD))
  return { result, getPrivateKey }
}

describe('useExportPrivateKeyScreenLogic Enter key', () => {
  it('submits the password on an Enter pressed in the field', async () => {
    const { result, getPrivateKey } = renderWithPassword()

    await act(async () => {
      result.current.handleOnKeyDown(keyDown('Enter'))
    })

    expect(getPrivateKey).toHaveBeenCalledTimes(1)
    expect(getPrivateKey).toHaveBeenCalledWith(PASSWORD, account)
    expect(result.current.error).toBe('Password is incorrect')
  })

  it('submits nothing while a held Enter repeats', async () => {
    const { result, getPrivateKey } = renderWithPassword()

    await act(async () => {
      result.current.handleOnKeyDown(keyDown('Enter', { repeat: true }))
      result.current.handleOnKeyDown(keyDown('Enter', { repeat: true }))
    })

    expect(getPrivateKey).not.toHaveBeenCalled()
    expect(result.current.error).toBe('')
  })

  it('submits nothing on the Enter that ends an input method composition', async () => {
    const { result, getPrivateKey } = renderWithPassword()

    await act(async () => {
      result.current.handleOnKeyDown(keyDown('Enter', { isComposing: true }))
    })

    expect(getPrivateKey).not.toHaveBeenCalled()
  })

  it('submits nothing on other keys', async () => {
    const { result, getPrivateKey } = renderWithPassword()

    await act(async () => {
      result.current.handleOnKeyDown(keyDown('a'))
      result.current.handleOnKeyDown(keyDown(' '))
    })

    expect(getPrivateKey).not.toHaveBeenCalled()
  })
})
