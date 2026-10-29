import { act, renderHook, waitFor } from '@testing-library/react'
import {
  P2MR_LEAF_VERSION_V1,
  bytesToHex,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import { KeyringType } from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'
import { describe, expect, it } from 'vitest'

import {
  estimateQbitP2mrSendPreflight,
  usePrepareSendQBTCallback,
} from '../../src/hooks/transactions'
import { accountActions } from '../../src/reducers/accounts'
import { settingsActions } from '../../src/reducers/settings'
import { transactionsActions } from '../../src/reducers/transactions'
import { useFeeRateBarLogic } from '../../src/ui-hooks/useFeeRateBarLogic'
import { createHookTestHarness, createWalletMock } from './testHelpers'

function p2mrAccount(pubkeyHex = '11'.repeat(32)) {
  const pubkey = hexToBytes(pubkeyHex)
  const leafScript = singleKeyLeafScript(pubkey)
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
  const scriptPubKey = p2mrScriptPubKey(leafHash)
  return {
    type: KeyringType.QbitHdKeyring,
    address: p2mrAddressFromPubkey(pubkey, 'regtest'),
    pubkey: pubkeyHex,
    key: 'qbit-fee-account',
    flag: 0,
    p2mr: {
      pubkey: pubkeyHex,
      path: "m/87'/1'/0'/0/0",
      scriptPubKey: bytesToHex(scriptPubKey),
      leafScript: bytesToHex(leafScript),
      addresses: {
        mainnet: p2mrAddressFromPubkey(pubkey, 'mainnet'),
        testnet4: p2mrAddressFromPubkey(pubkey, 'testnet4'),
        signet: p2mrAddressFromPubkey(pubkey, 'signet'),
        regtest: p2mrAddressFromPubkey(pubkey, 'regtest'),
      },
      hkdf: { account: 0, change: 0, index: 0 },
      signatureCounter: {
        count: 0,
        limit: 1073741824,
        remaining: 1073741824,
        state: 'normal' as const,
        provenance: 'local' as const,
      },
    },
  }
}

function qbitFeeSummary(availability: 'available' | 'unavailable' = 'available') {
  return {
    list: [
      { title: 'slow', desc: 'slow', feeRate: 1, targetBlocks: 20 },
      { title: 'avg', desc: 'avg', feeRate: 2, targetBlocks: 6 },
      { title: 'fast', desc: 'fast', feeRate: 3, targetBlocks: 2 },
    ],
    quote: {
      source: 'esplora' as const,
      availability,
      freshness: availability === 'available' ? ('live' as const) : ('fallback' as const),
      ...(availability === 'unavailable' ? { fallbackReason: 'empty' as const } : {}),
    },
  }
}

describe('useFeeRateBarLogic', () => {
  it('keeps an exact qbit recommendation selected and passes it to transaction creation', async () => {
    const account = p2mrAccount()
    const utxos = [
      {
        txid: 'ab'.repeat(32),
        vout: 0,
        satoshis: 100_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      } as any,
    ]
    const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'regtest')
    const expectedFee = estimateQbitP2mrSendPreflight({
      utxos,
      account: account as any,
      amount: 10_000,
      feeRate: 1,
    }).estimatedFee
    expect(expectedFee).toBe(3_860)

    const wallet = createWalletMock()
    wallet.getFeeSummary.mockResolvedValue(qbitFeeSummary())
    wallet.createSendQbitPsbt.mockResolvedValue({
      psbtHex: 'prepared',
      estimatedFee: expectedFee,
    } as any)
    const { store, wrapper } = createHookTestHarness({ wallet })
    store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_REGTEST }))
    store.dispatch(accountActions.setCurrent(account))
    store.dispatch(
      transactionsActions.setUtxos({
        address: account.address,
        chain: ChainType.QBIT_REGTEST,
        utxos,
      })
    )

    const { result } = renderHook(
      () => ({
        feeBar: useFeeRateBarLogic({}),
        prepareSend: usePrepareSendQBTCallback(),
      }),
      { wrapper }
    )
    await waitFor(() => {
      expect(result.current.feeBar.feeOptions).toHaveLength(4)
    })

    act(() => {
      result.current.feeBar.setFeeOptionIndex(0)
    })
    await waitFor(() => {
      expect(store.getState().ui.feeRateBar).toMatchObject({
        feeOptionIndex: 0,
        feeRateInputVal: '1',
        feeRate: 1,
      })
    })

    // The controlled amount input may normalize formatting on mount. An exact
    // recommended value remains the backend option rather than becoming Custom.
    act(() => {
      result.current.feeBar.adjustFeeRateInput('1.0')
    })
    expect(store.getState().ui.feeRateBar).toMatchObject({
      feeOptionIndex: 0,
      feeRateInputVal: '1',
      feeRate: 1,
    })

    let prepared: any
    await act(async () => {
      prepared = await result.current.prepareSend({
        toAddressInfo: { address: recipient },
        toAmount: 10_000,
        feeRate: store.getState().ui.feeRateBar.feeRate,
      })
    })

    expect(wallet.createSendQbitPsbt).toHaveBeenCalledWith(expect.objectContaining({ feeRate: 1 }))
    expect(prepared.estimatedFee).toBe(3_860)
  })

  it('still clamps a manual sub-1 Custom fee when low-fee mode is disabled', async () => {
    const wallet = createWalletMock()
    wallet.getFeeSummary.mockResolvedValue(qbitFeeSummary())
    const { store, wrapper } = createHookTestHarness({ wallet })
    store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_REGTEST }))
    const { result } = renderHook(() => useFeeRateBarLogic({}), { wrapper })
    await waitFor(() => {
      expect(result.current.feeOptions).toHaveLength(4)
      expect(result.current.supportLowFeeMode).toBe(false)
    })

    act(() => {
      result.current.setFeeOptionIndex(0)
    })
    await waitFor(() => {
      expect(store.getState().ui.feeRateBar.feeRate).toBe(1)
    })

    act(() => {
      result.current.setFeeOptionIndex(3)
    })
    await waitFor(() => {
      expect(store.getState().ui.feeRateBar.feeOptionIndex).toBe(3)
    })
    act(() => {
      result.current.adjustFeeRateInput('0.25')
    })

    await waitFor(() => {
      expect(store.getState().ui.feeRateBar).toMatchObject({
        feeOptionIndex: 3,
        feeRateInputVal: '1',
        feeRate: 1,
      })
    })
  })

  it('allows typing a decimal custom rate from an integer recommendation', async () => {
    const wallet = createWalletMock()
    wallet.getFeeSummary.mockResolvedValue(qbitFeeSummary())
    const { store, wrapper } = createHookTestHarness({ wallet })
    const { result } = renderHook(() => useFeeRateBarLogic({}), { wrapper })
    await waitFor(() => {
      expect(result.current.feeOptions).toHaveLength(4)
    })

    act(() => {
      result.current.setFeeOptionIndex(2)
    })
    await waitFor(() => {
      expect(store.getState().ui.feeRateBar).toMatchObject({
        feeOptionIndex: 2,
        feeRateInputVal: '3',
        feeRate: 3,
      })
    })

    act(() => {
      result.current.adjustFeeRateInput('3.')
    })
    expect(store.getState().ui.feeRateBar).toMatchObject({
      feeOptionIndex: 3,
      feeRateInputVal: '3.',
      feeRate: 3,
    })

    act(() => {
      result.current.adjustFeeRateInput('3.5')
    })
    await waitFor(() => {
      expect(store.getState().ui.feeRateBar).toMatchObject({
        feeOptionIndex: 3,
        feeRateInputVal: '3.5',
        feeRate: 3.5,
      })
    })
  })

  it('preserves qbit target descriptions and exposes unavailable fallback status', async () => {
    const wallet = createWalletMock()
    wallet.getFeeSummary.mockResolvedValue(qbitFeeSummary('unavailable'))
    const { store, wrapper } = createHookTestHarness({ wallet })
    store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_MAINNET }))

    const { result } = renderHook(() => useFeeRateBarLogic({}), { wrapper })
    await waitFor(() => {
      expect(result.current.feeEstimateUnavailable).toBe(true)
      expect(result.current.feeOptions).toHaveLength(4)
    })

    expect(result.current.supportLowFeeMode).toBe(false)
    expect(result.current.feeOptions.slice(0, 3).map(option => option.desc)).toEqual([
      'qbit_feerate_target_desc',
      'qbit_feerate_target_desc',
      'qbit_feerate_target_desc',
    ])
    expect(wallet.getLowFeeSummary).not.toHaveBeenCalled()
  })

  it('refreshes qbit fee options and quote metadata when the exact chain changes', async () => {
    const testnetSummary = qbitFeeSummary()
    const regtestSummary = {
      ...qbitFeeSummary('unavailable'),
      list: [
        { title: 'slow', desc: 'slow', feeRate: 4, targetBlocks: 12 },
        { title: 'avg', desc: 'avg', feeRate: 5, targetBlocks: 4 },
        { title: 'fast', desc: 'fast', feeRate: 6, targetBlocks: 1 },
      ],
    }
    let resolveTestnetSummary!: (summary: ReturnType<typeof qbitFeeSummary>) => void
    let resolveRegtestSummary!: (summary: ReturnType<typeof qbitFeeSummary>) => void
    const pendingTestnetSummary = new Promise<ReturnType<typeof qbitFeeSummary>>(resolve => {
      resolveTestnetSummary = resolve
    })
    const pendingRegtestSummary = new Promise<ReturnType<typeof qbitFeeSummary>>(resolve => {
      resolveRegtestSummary = resolve
    })
    const wallet = createWalletMock()
    wallet.getFeeSummary
      .mockReturnValueOnce(pendingTestnetSummary)
      .mockReturnValueOnce(pendingRegtestSummary)
    const { store, wrapper } = createHookTestHarness({ wallet })
    store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))

    const { result } = renderHook(() => useFeeRateBarLogic({}), { wrapper })
    await waitFor(() => {
      expect(wallet.getFeeSummary).toHaveBeenCalledTimes(1)
    })

    act(() => {
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_REGTEST }))
    })

    await waitFor(() => {
      expect(wallet.getFeeSummary).toHaveBeenCalledTimes(2)
    })
    await act(async () => {
      resolveRegtestSummary(regtestSummary)
      await pendingRegtestSummary
    })
    await waitFor(() => {
      expect(result.current.feeOptions.slice(0, 3).map(option => option.feeRate)).toEqual([4, 5, 6])
      expect(result.current.feeQuote).toEqual(regtestSummary.quote)
    })

    await act(async () => {
      resolveTestnetSummary(testnetSummary)
      await pendingTestnetSummary
    })
    expect(result.current.feeOptions.slice(0, 3).map(option => option.feeRate)).toEqual([4, 5, 6])
    expect(result.current.feeQuote).toEqual(regtestSummary.quote)
    expect(wallet.getLowFeeSummary).not.toHaveBeenCalled()
  })

  it('keeps an above-ceiling qbit custom rate while the fee summary is pending', async () => {
    let resolveFeeSummary!: (summary: ReturnType<typeof qbitFeeSummary>) => void
    const pendingFeeSummary = new Promise<ReturnType<typeof qbitFeeSummary>>(resolve => {
      resolveFeeSummary = resolve
    })
    const wallet = createWalletMock()
    wallet.getFeeSummary.mockReturnValue(pendingFeeSummary)
    const { store, wrapper } = createHookTestHarness({ wallet })
    store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_MAINNET }))
    const { result } = renderHook(() => useFeeRateBarLogic({}), { wrapper })

    await waitFor(() => {
      expect(wallet.getFeeSummary).toHaveBeenCalledTimes(1)
    })
    expect(result.current.feeOptions).toEqual([])

    act(() => {
      result.current.setFeeOptionIndex(3)
    })
    await waitFor(() => {
      expect(store.getState().ui.feeRateBar.feeOptionIndex).toBe(3)
    })

    act(() => {
      result.current.adjustFeeRateInput('10001')
    })
    await waitFor(() => {
      expect(store.getState().ui.feeRateBar).toMatchObject({
        feeOptionIndex: 3,
        feeRateInputVal: '10001',
        feeRate: 10001,
      })
    })
    expect(result.current.feeOptions).toEqual([])

    await act(async () => {
      resolveFeeSummary(qbitFeeSummary())
      await pendingFeeSummary
    })
    await waitFor(() => {
      expect(result.current.feeOptions).toHaveLength(4)
    })
    expect(store.getState().ui.feeRateBar).toMatchObject({
      feeOptionIndex: 3,
      feeRateInputVal: '10001',
      feeRate: 10001,
    })
  })

  it('keeps an above-ceiling qbit custom rate visible for the create screen to block', async () => {
    const wallet = createWalletMock()
    wallet.getFeeSummary.mockResolvedValue(qbitFeeSummary())
    const { store, wrapper } = createHookTestHarness({ wallet })
    const { result } = renderHook(() => useFeeRateBarLogic({}), { wrapper })
    await waitFor(() => expect(result.current.feeOptions).toHaveLength(4))

    act(() => {
      result.current.setFeeOptionIndex(3)
      result.current.adjustFeeRateInput('10001')
    })
    await waitFor(() => {
      expect(store.getState().ui.feeRateBar).toMatchObject({
        feeOptionIndex: 3,
        feeRateInputVal: '10001',
        feeRate: 10001,
      })
    })
  })

  describe('with a quote its screen shares', () => {
    type SharedQuote = NonNullable<Parameters<typeof useFeeRateBarLogic>[0]['quote']>

    it('offers the shared quote without reading its own, and moves to a newer one in the same render', async () => {
      const wallet = createWalletMock()
      const { wrapper } = createHookTestHarness({ wallet })
      const first = qbitFeeSummary()
      const second = {
        ...qbitFeeSummary('unavailable'),
        list: [
          { title: 'slow', desc: 'slow', feeRate: 4, targetBlocks: 12 },
          { title: 'avg', desc: 'avg', feeRate: 5, targetBlocks: 4 },
          { title: 'fast', desc: 'fast', feeRate: 6, targetBlocks: 1 },
        ],
      }
      const { result, rerender } = renderHook(
        ({ quote }: { quote: SharedQuote }) => useFeeRateBarLogic({ quote }),
        { wrapper, initialProps: { quote: { status: 'loading' } } }
      )
      expect(result.current.feeOptions).toEqual([])

      rerender({ quote: { status: 'loaded', summary: first } })
      expect(result.current.feeOptions.map(option => option.feeRate)).toEqual([1, 2, 3, 0])
      expect(result.current.feeQuote).toEqual(first.quote)

      rerender({ quote: { status: 'loaded', summary: second } })
      expect(result.current.feeOptions.map(option => option.feeRate)).toEqual([4, 5, 6, 0])
      expect(result.current.feeQuote).toEqual(second.quote)
      expect(result.current.feeEstimateUnavailable).toBe(true)

      // A read that failed leaves nothing to offer, as one of its own would.
      rerender({ quote: { status: 'loaded' } })
      expect(result.current.feeOptions).toEqual([])
      expect(wallet.getFeeSummary).not.toHaveBeenCalled()
    })

    it('leaves the shared quote as it is when low-fee mode lowers the slow rate', async () => {
      const wallet = createWalletMock()
      wallet.getLowFeeSummary.mockResolvedValue({
        list: [
          { title: 'slow', desc: 'slow', feeRate: 0.5 },
          { title: 'avg', desc: 'avg', feeRate: 0.8 },
          { title: 'fast', desc: 'fast', feeRate: 1.5 },
        ],
      })
      const { store, wrapper } = createHookTestHarness({ wallet })
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_MAINNET }))
      // A summary without qbit quote metadata, which low-fee mode applies to.
      const summary = {
        list: [
          { title: 'slow', desc: 'slow', feeRate: 2 },
          { title: 'avg', desc: 'avg', feeRate: 3 },
          { title: 'fast', desc: 'fast', feeRate: 4 },
        ],
      }
      const before = JSON.parse(JSON.stringify(summary))
      const quote: SharedQuote = { status: 'loaded', summary }

      const { result } = renderHook(() => useFeeRateBarLogic({ quote }), { wrapper })
      await waitFor(() => {
        expect(result.current.feeOptions.map(option => option.feeRate)).toEqual([0.8, 3, 4, 0])
      })
      expect(result.current.supportLowFeeMode).toBe(true)
      expect(summary).toEqual(before)
      expect(wallet.getFeeSummary).not.toHaveBeenCalled()
    })
  })
})
