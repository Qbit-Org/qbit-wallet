import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  useAddressExplorerUrl,
  useGetTxExplorerUrlCallback,
  useTxExplorerUrl,
} from '../src/hooks/settings'
import { settingsActions } from '../src/reducers/settings'
import { ChainType } from '@qbit/wallet-types'

import { createHookTestHarness } from './ui-hooks/testHelpers'

describe('explorer URL hooks', () => {
  it('returns configured Qbit URLs and fails closed without an explorer', async () => {
    const txid = 'ab'.repeat(32)
    const address = 'qbit-address'
    const { store, wrapper } = createHookTestHarness()
    const { result } = renderHook(
      () => ({
        addressUrl: useAddressExplorerUrl(address),
        getTxUrl: useGetTxExplorerUrlCallback(),
        txUrl: useTxExplorerUrl(txid),
      }),
      { wrapper }
    )

    expect(result.current.txUrl).toBe(`https://mempool.qbit.org/tx/${txid}`)
    expect(result.current.getTxUrl(txid)).toBe(`https://mempool.qbit.org/tx/${txid}`)
    expect(result.current.addressUrl).toBe(
      'https://mempool.qbit.org/address/qbit-address'
    )

    act(() => {
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })

    await waitFor(() => {
      expect(result.current.txUrl).toBe(
        `https://mempool-testnet.qbit.org/tx/${txid}`
      )
      expect(result.current.getTxUrl(txid)).toBe(
        `https://mempool-testnet.qbit.org/tx/${txid}`
      )
      expect(result.current.addressUrl).toBe(
        'https://mempool-testnet.qbit.org/address/qbit-address'
      )
    })

    act(() => {
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_REGTEST }))
    })

    await waitFor(() => {
      expect(result.current.txUrl).toBe('')
      expect(result.current.getTxUrl(txid)).toBe('')
      expect(result.current.addressUrl).toBe('')
    })
  })
})
