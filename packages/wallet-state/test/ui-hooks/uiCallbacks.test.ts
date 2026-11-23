import { describe, expect, it } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

import {
  useResetFeeRateBar,
  useResetTxState,
  useResetUiTxCreateScreen,
  useUpdateFeeRateBar,
  useUpdateUiTxCreateScreen,
} from '../../src/hooks/ui'
import { createHookTestHarness } from './testHelpers'

describe('ui update callbacks', () => {
  it.each([
    {
      name: 'useUpdateUiTxCreateScreen',
      useHook: useUpdateUiTxCreateScreen,
      trigger: callback => callback({ inputAmount: '1' }),
    },
    {
      name: 'useUpdateFeeRateBar',
      useHook: useUpdateFeeRateBar,
      trigger: callback => callback({ feeRate: 12 }),
    },
    {
      name: 'useResetFeeRateBar',
      useHook: useResetFeeRateBar,
      trigger: callback => callback(),
    },
    {
      name: 'useResetTxState',
      useHook: useResetTxState,
      trigger: callback => callback(),
    },
    {
      name: 'useResetUiTxCreateScreen',
      useHook: useResetUiTxCreateScreen,
      trigger: callback => callback(),
    },
  ])('keeps $name stable across redux updates', async ({ useHook, trigger }) => {
    const { wrapper } = createHookTestHarness()
    const { result, rerender } = renderHook(() => useHook(), { wrapper })
    const initialCallback = result.current

    act(() => {
      trigger(result.current as any)
    })
    rerender()

    await waitFor(() => {
      expect(result.current).toBe(initialCallback)
    })
  })
})
