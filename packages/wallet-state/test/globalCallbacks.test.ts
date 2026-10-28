import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import { AddressType } from '@qbit/wallet-types'

import { useRestoreQbitWalletCallback } from '../src/hooks/global'
import { createHookTestHarness, createWalletMock } from './ui-hooks/testHelpers'

describe('global callbacks', () => {
  it('sends concrete options when qbit restore options are omitted', async () => {
    const report = { floorsCompleted: true }
    const restoreQbitKeyringWithFloors = vi.fn().mockResolvedValue(report)
    const wallet = {
      ...createWalletMock(),
      restoreQbitKeyringWithFloors,
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
})
