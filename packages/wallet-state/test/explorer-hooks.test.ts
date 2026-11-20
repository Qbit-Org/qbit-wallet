import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useTxExplorerUrl } from '../src/hooks/settings'
import { settingsActions } from '../src/reducers/settings'
import { ChainType } from '@qbit/wallet-types'

import { createHookTestHarness } from './ui-hooks/testHelpers'

describe('explorer URL hooks', () => {
  it('returns configured Qbit URLs and fails closed without an explorer', async () => {
    const txid = 'ab'.repeat(32)
    const { store, wrapper } = createHookTestHarness()
    const { result } = renderHook(
      () => ({
        txUrl: useTxExplorerUrl(txid),
      }),
      { wrapper }
    )

    expect(result.current.txUrl).toBe(`https://mempool.qbit.org/tx/${txid}`)

    act(() => {
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })

    await waitFor(() => {
      expect(result.current.txUrl).toBe(
        `https://mempool-testnet.qbit.org/tx/${txid}`
      )
    })

    act(() => {
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_REGTEST }))
    })

    await waitFor(() => {
      expect(result.current.txUrl).toBe('')
    })
  })
})
