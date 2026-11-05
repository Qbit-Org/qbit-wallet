import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import { AddressType } from '@qbit/wallet-types'

import { useCreateAccountCallback, useRestoreQbitWalletCallback } from '../src/hooks/global'
import { globalActions } from '../src/reducers'
import { createHookTestHarness, createWalletMock } from './ui-hooks/testHelpers'

describe('global callbacks', () => {
  it('sends concrete options when qbit restore options are omitted', async () => {
    const report = { floorsCompleted: true }
    const restoreQbitKeyringWithFloors = vi.fn().mockResolvedValue(report)
    const wallet = {
      ...createWalletMock(),
      restoreQbitKeyringWithFloors,
      isUnlocked: vi.fn().mockResolvedValue(true),
    }
    const { wrapper } = createHookTestHarness({ wallet })
    const { result } = renderHook(() => useRestoreQbitWalletCallback(), { wrapper })

    await act(async () => {
      await result.current(
        'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango',
        "m/87'/0'/0'/0",
        '',
        AddressType.P2MR
      )
    })

    expect(restoreQbitKeyringWithFloors).toHaveBeenCalledWith(
      'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango',
      "m/87'/0'/0'/0",
      '',
      AddressType.P2MR,
      {}
    )
  })

  const MNEMONIC = 'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'

  /** A create or restore whose background call returns after the wallet locked. */
  function flowEndingLocked(stillUnlocked: boolean) {
    const wallet = {
      ...createWalletMock(),
      createKeyringWithMnemonics: vi.fn().mockResolvedValue(undefined),
      restoreQbitKeyringWithFloors: vi.fn().mockResolvedValue({ floorsCompleted: true }),
      isUnlocked: vi.fn().mockResolvedValue(stillUnlocked),
    }
    const harness = createHookTestHarness({ wallet })
    // The LOCKED broadcast that arrived mid-flow already set the store.
    harness.store.dispatch(globalActions.update({ isUnlocked: false }))
    return { ...harness, wallet }
  }

  const flows = [
    [
      'creating',
      () => useCreateAccountCallback(),
      (run: any) => run(MNEMONIC, "m/87'/0'/0'/0", '', AddressType.P2MR, 1),
    ],
    [
      'restoring',
      () => useRestoreQbitWalletCallback(),
      (run: any) => run(MNEMONIC, "m/87'/0'/0'/0", '', AddressType.P2MR),
    ],
  ] as const

  it.each(flows)('keeps the wallet shown as locked when it locked while %s it', async (_name, hook, call) => {
    const { wrapper, store, wallet } = flowEndingLocked(false)
    const { result } = renderHook(hook, { wrapper })

    await act(async () => {
      await call(result.current)
    })

    expect(wallet.isUnlocked).toHaveBeenCalled()
    expect(store.getState().global.isUnlocked).toBe(false)
  })

  it.each(flows)('shows the wallet unlocked after %s it when the background still is', async (_name, hook, call) => {
    const { wrapper, store } = flowEndingLocked(true)
    const { result } = renderHook(hook, { wrapper })

    await act(async () => {
      await call(result.current)
    })

    expect(store.getState().global.isUnlocked).toBe(true)
  })
})
