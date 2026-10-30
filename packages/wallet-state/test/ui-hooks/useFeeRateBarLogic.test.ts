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
import { KeyringType, type FeeSummary } from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'
import { describe, expect, it, vi } from 'vitest'

import {
  estimateQbitP2mrSendPreflight,
  usePrepareSendQBTCallback,
} from '../../src/hooks/transactions'
import { accountActions } from '../../src/reducers/accounts'
import { settingsActions } from '../../src/reducers/settings'
import { transactionsActions } from '../../src/reducers/transactions'
import { uiActions } from '../../src/reducers/ui'
import { feeRateOrigin, useFeeRateBarLogic } from '../../src/ui-hooks/useFeeRateBarLogic'
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

  it('says the relay floor is used, and uses it, when its own read fails', async () => {
    const wallet = createWalletMock()
    wallet.getFeeSummary.mockRejectedValue(new Error('locked'))
    const { store, wrapper } = createHookTestHarness({ wallet })
    store.dispatch((uiActions as any).updateFeeRateBar({ feeRate: 5, feeOptionIndex: 1 }))

    const { result } = renderHook(() => useFeeRateBarLogic({}), { wrapper })

    await waitFor(() => expect(result.current.feeEstimateUnavailable).toBe(true))
    expect(result.current.feeOptions.map(result.current.isCustomOption)).toEqual([true])
    expect(result.current.fallbackFeeRate).toBe(1)
    await waitFor(() => expect(store.getState().ui.feeRateBar.feeRate).toBe(1))
  })

  // The website PSBT risk popover shows one; the send screen's rate is in the
  // same store, and nothing reads a rate from a read-only bar.
  it.each([
    ['reads its quote', () => Promise.resolve(qbitFeeSummary())],
    ['cannot read its quote', () => Promise.reject(new Error('locked'))],
  ])(
    'leaves the selected rate alone, and claims no rate, in a read-only bar that %s',
    async (_label, read) => {
      const wallet = createWalletMock()
      wallet.getFeeSummary.mockImplementation(read)
      const { store, wrapper } = createHookTestHarness({ wallet })
      store.dispatch(
        (uiActions as any).updateFeeRateBar({ feeRate: 5, feeRateInputVal: '5', feeOptionIndex: 1 })
      )

      const { result } = renderHook(() => useFeeRateBarLogic({ readonly: true }), { wrapper })
      await waitFor(() => expect(wallet.getFeeSummary).toHaveBeenCalled())
      await act(async () => {})

      expect(store.getState().ui.feeRateBar).toMatchObject({ feeRate: 5, feeOptionIndex: 1 })
      expect(result.current.fallbackFeeRate).toBeUndefined()
    }
  )

  describe('with a quote its screen shares', () => {
    type SharedQuote = NonNullable<Parameters<typeof useFeeRateBarLogic>[0]['quote']>

    const feeRates = (options: { feeRate: number }[]) => options.map(option => option.feeRate)

    function noMetadataSummary(rates: number[]) {
      return {
        list: rates.map((feeRate, index) => ({ title: `tier-${index}`, desc: '', feeRate })),
      }
    }

    function lowFeeSummary(rates: number[]) {
      return { list: rates.map((feeRate, index) => ({ title: `low-${index}`, desc: '', feeRate })) }
    }

    let reads = 0
    /** A read of the quote that landed, named as no other read is; without a summary it failed. */
    function landed(summary?: FeeSummary): Extract<SharedQuote, { status: 'loaded' }> {
      reads += 1
      return {
        status: 'loaded',
        read: `read-${reads}`,
        ...(summary !== undefined ? { summary } : {}),
      }
    }

    // On Qbit mainnet, the default network, where low-fee mode is configured.
    function renderSharedFeeBar(initialQuote: SharedQuote) {
      const wallet = createWalletMock()
      const harness = createHookTestHarness({ wallet })
      // Each render's quote and what the bar offered in that same render,
      // before any effect of it has run.
      const renders: { quote: SharedQuote; rates: number[]; feeQuote: unknown }[] = []
      const rendered = renderHook(
        ({ quote }: { quote: SharedQuote }) => {
          const feeBar = useFeeRateBarLogic({ quote })
          renders.push({ quote, rates: feeRates(feeBar.feeOptions), feeQuote: feeBar.feeQuote })
          return feeBar
        },
        { wrapper: harness.wrapper, initialProps: { quote: initialQuote } }
      )
      return { ...rendered, ...harness, wallet, renders }
    }

    it('offers the shared quote without reading its own, in the same render as the quote', () => {
      const first = qbitFeeSummary()
      const second = {
        ...qbitFeeSummary('unavailable'),
        list: [
          { title: 'slow', desc: 'slow', feeRate: 4, targetBlocks: 12 },
          { title: 'avg', desc: 'avg', feeRate: 5, targetBlocks: 4 },
          { title: 'fast', desc: 'fast', feeRate: 6, targetBlocks: 1 },
        ],
      }
      const { result, rerender, renders, wallet } = renderSharedFeeBar({ status: 'loading' })
      expect(result.current.feeOptions).toEqual([])

      rerender({ quote: landed(first) })
      rerender({ quote: landed(second) })

      const loadedRenders = renders.filter(render => render.quote.status === 'loaded')
      expect(loadedRenders.length).toBeGreaterThan(0)
      for (const render of loadedRenders) {
        const summary = (render.quote as { summary: typeof first }).summary
        expect(render.rates).toEqual([...feeRates(summary.list), 0])
        expect(render.feeQuote).toEqual(summary.quote)
      }
      expect(result.current.feeEstimateUnavailable).toBe(true)
      expect(wallet.getFeeSummary).not.toHaveBeenCalled()
    })

    it('keeps the options and the selected rate while the quote loads, never a default rate', async () => {
      const first = qbitFeeSummary()
      const { result, rerender, store } = renderSharedFeeBar({ status: 'loading' })
      act(() => {
        store.dispatch((uiActions as any).updateFeeRateBar({ feeRate: 7, feeOptionIndex: 1 }))
      })
      await act(async () => {})
      // Nothing loaded yet: the rate already selected stays.
      expect(store.getState().ui.feeRateBar.feeRate).toBe(7)

      rerender({ quote: landed(first) })
      await waitFor(() => expect(store.getState().ui.feeRateBar.feeRate).toBe(2))

      // The screen reads the quote again, as it does for another network.
      rerender({ quote: { status: 'loading' } })
      expect(feeRates(result.current.feeOptions)).toEqual([1, 2, 3, 0])
      expect(result.current.feeQuote).toEqual(first.quote)
      await act(async () => {})
      expect(store.getState().ui.feeRateBar.feeRate).toBe(2)
    })

    it('keeps the options and the selected rate while a low-fee read is pending', async () => {
      const first = qbitFeeSummary()
      const { result, rerender, store, wallet } = renderSharedFeeBar(landed(first))
      await waitFor(() => expect(store.getState().ui.feeRateBar.feeRate).toBe(2))
      let resolveLowFee!: (summary: ReturnType<typeof lowFeeSummary>) => void
      wallet.getLowFeeSummary.mockReturnValue(
        new Promise(resolve => {
          resolveLowFee = resolve
        })
      )

      rerender({ quote: landed(noMetadataSummary([2, 3, 4])) })
      expect(feeRates(result.current.feeOptions)).toEqual([1, 2, 3, 0])
      await act(async () => {})
      expect(store.getState().ui.feeRateBar.feeRate).toBe(2)

      await act(async () => {
        resolveLowFee(lowFeeSummary([0.5, 0.8]))
      })
      expect(feeRates(result.current.feeOptions)).toEqual([0.8, 3, 4, 0])
      await waitFor(() => expect(store.getState().ui.feeRateBar.feeRate).toBe(3))
    })

    it('never joins low-fee rates read for an earlier quote to a newer one', async () => {
      const earlier = noMetadataSummary([2, 3, 4])
      const newer = noMetadataSummary([5, 6, 7])
      const wallet = createWalletMock()
      const { store, wrapper } = createHookTestHarness({ wallet })
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_MAINNET }))
      wallet.getLowFeeSummary.mockResolvedValueOnce(lowFeeSummary([0.5, 0.8]))
      let resolveNewerLowFee!: (summary: ReturnType<typeof lowFeeSummary>) => void
      wallet.getLowFeeSummary.mockReturnValueOnce(
        new Promise(resolve => {
          resolveNewerLowFee = resolve
        })
      )
      const { result, rerender } = renderHook(
        ({ quote }: { quote: SharedQuote }) => useFeeRateBarLogic({ quote }),
        { wrapper, initialProps: { quote: landed(earlier) as SharedQuote } }
      )
      await waitFor(() => expect(feeRates(result.current.feeOptions)).toEqual([0.8, 3, 4, 0]))

      rerender({ quote: landed(newer) })
      // Until the newer quote's low-fee read lands, the earlier quote's whole set stays.
      expect(feeRates(result.current.feeOptions)).toEqual([0.8, 3, 4, 0])

      await act(async () => {
        resolveNewerLowFee(lowFeeSummary([0.2, 0.4]))
      })
      expect(feeRates(result.current.feeOptions)).toEqual([0.4, 6, 7, 0])
    })

    it.each([
      ['the low-fee slow rate when Normal is above 1', [0.5, 2], 0.5],
      ['0.1 when both low-fee rates are above 1', [3, 2], 0.1],
    ])('offers %s', async (_label, lowFeeRates, slowRate) => {
      const wallet = createWalletMock()
      wallet.getLowFeeSummary.mockResolvedValue(lowFeeSummary(lowFeeRates))
      const { store, wrapper } = createHookTestHarness({ wallet })
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_MAINNET }))
      const quote: SharedQuote = landed(noMetadataSummary([2, 3, 4]))

      const { result } = renderHook(() => useFeeRateBarLogic({ quote }), { wrapper })

      await waitFor(() => expect(feeRates(result.current.feeOptions)).toEqual([slowRate, 3, 4, 0]))
    })

    it('falls back to the quote’s own rates when the low-fee read fails', async () => {
      const wallet = createWalletMock()
      wallet.getLowFeeSummary.mockRejectedValue(new Error('explorer down'))
      const { store, wrapper } = createHookTestHarness({ wallet })
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_MAINNET }))
      const quote: SharedQuote = landed(noMetadataSummary([2, 3, 4]))

      const { result } = renderHook(() => useFeeRateBarLogic({ quote }), { wrapper })

      await waitFor(() => expect(feeRates(result.current.feeOptions)).toEqual([2, 3, 4, 0]))
      expect(result.current.feeOptions[0].title).toBe('slow')
      await waitFor(() => expect(store.getState().ui.feeRateBar.feeRate).toBe(3))
    })

    it('says the relay floor is used, and uses it, when the shared read fails', async () => {
      const { result, rerender, store } = renderSharedFeeBar(landed(qbitFeeSummary()))
      await waitFor(() => expect(store.getState().ui.feeRateBar.feeRate).toBe(2))

      rerender({ quote: landed() })

      expect(result.current.feeEstimateUnavailable).toBe(true)
      // Only Custom, to set a rate above the floor.
      expect(result.current.feeOptions).toHaveLength(1)
      expect(result.current.isCustomOption(result.current.feeOptions[0])).toBe(true)
      await waitFor(() =>
        expect(store.getState().ui.feeRateBar.feeRate).toBe(result.current.fallbackFeeRate)
      )
    })

    it('gives each option the index it selects, from three tiers at most', () => {
      const wallet = createWalletMock()
      const { wrapper } = createHookTestHarness({ wallet })
      const fourTiers = {
        ...qbitFeeSummary(),
        list: [...qbitFeeSummary().list, { title: 'extra', desc: '', feeRate: 9, targetBlocks: 1 }],
      }
      const { result, rerender } = renderHook(
        ({ quote }: { quote: SharedQuote }) => useFeeRateBarLogic({ quote }),
        {
          wrapper,
          initialProps: { quote: landed(fourTiers) as SharedQuote },
        }
      )

      // A fourth tier would stand where Custom's index is.
      expect(result.current.feeOptions.map(option => [option.index, option.feeRate])).toEqual([
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
      ])

      rerender({ quote: landed() })
      expect(result.current.feeOptions.map(option => option.index)).toEqual([3])
    })

    it('shows the relay floor in the input, not a tier’s earlier rate, once the quote cannot be read', async () => {
      const { result, rerender, store } = renderSharedFeeBar(landed(qbitFeeSummary()))
      await waitFor(() => expect(result.current.feeOptions).toHaveLength(4))
      act(() => {
        result.current.setFeeOptionIndex(2)
      })
      expect(result.current.feeRateInputVal).toBe('3')

      rerender({ quote: landed() })
      expect(result.current.feeRateInputVal).toBe('1')
      await waitFor(() => expect(store.getState().ui.feeRateBar.feeRate).toBe(1))

      // The input hands back the value it is given: not a rate the user typed.
      act(() => {
        result.current.adjustFeeRateInput('1')
      })
      expect(store.getState().ui.feeRateBar.feeOptionIndex).toBe(2)

      act(() => {
        result.current.adjustFeeRateInput('4')
      })
      await waitFor(() =>
        expect(store.getState().ui.feeRateBar).toMatchObject({ feeOptionIndex: 3, feeRate: 4 })
      )
      expect(result.current.feeRateInputVal).toBe('4')
    })

    it('starts Custom from the relay floor in use, not a tier’s earlier rate', async () => {
      const { result, rerender, store } = renderSharedFeeBar(landed(qbitFeeSummary()))
      await waitFor(() => expect(result.current.feeOptions).toHaveLength(4))
      act(() => {
        result.current.setFeeOptionIndex(2)
      })
      rerender({ quote: landed() })
      await waitFor(() => expect(store.getState().ui.feeRateBar.feeRate).toBe(1))

      act(() => {
        result.current.setFeeOptionIndex(3)
      })

      expect(store.getState().ui.feeRateBar).toMatchObject({
        feeOptionIndex: 3,
        feeRateInputVal: '1',
      })
      await act(async () => {})
      expect(store.getState().ui.feeRateBar.feeRate).toBe(1)
      expect(result.current.feeRateInputVal).toBe('1')
    })

    it('names the relay floor only while it is the rate in use', async () => {
      const floorTiers = {
        ...qbitFeeSummary('unavailable'),
        list: qbitFeeSummary().list.map(tier => ({ ...tier, feeRate: 1 })),
      }
      const { result, rerender, store } = renderSharedFeeBar(landed())
      await waitFor(() => expect(store.getState().ui.feeRateBar.feeRate).toBe(1))
      expect(result.current.fallbackFeeRate).toBe(1)

      act(() => {
        result.current.setFeeOptionIndex(3)
      })
      act(() => {
        result.current.adjustFeeRateInput('5')
      })
      await waitFor(() => expect(store.getState().ui.feeRateBar.feeRate).toBe(5))
      expect(result.current.feeEstimateUnavailable).toBe(true)
      expect(result.current.fallbackFeeRate).toBeUndefined()

      // A quote without estimates offers tiers at the floor.
      rerender({ quote: landed(floorTiers) })
      act(() => {
        result.current.setFeeOptionIndex(1)
      })
      await waitFor(() => expect(store.getState().ui.feeRateBar.feeRate).toBe(1))
      expect(result.current.feeEstimateUnavailable).toBe(true)
      expect(result.current.fallbackFeeRate).toBe(1)
      act(() => {
        result.current.setFeeOptionIndex(3)
        result.current.adjustFeeRateInput('5')
      })
      expect(result.current.fallbackFeeRate).toBeUndefined()
    })

    it('offers no low-fee mode when its read has no slow rate to put in', async () => {
      const wallet = createWalletMock()
      wallet.getLowFeeSummary.mockResolvedValue({ list: [] })
      const { store, wrapper } = createHookTestHarness({ wallet })
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_MAINNET }))
      const quote: SharedQuote = landed(noMetadataSummary([2, 3, 4]))

      const { result } = renderHook(() => useFeeRateBarLogic({ quote }), { wrapper })

      await waitFor(() => expect(wallet.getLowFeeSummary).toHaveBeenCalled())
      await waitFor(() => expect(feeRates(result.current.feeOptions)).toEqual([2, 3, 4, 0]))
      expect(result.current.feeOptions[0].title).toBe('slow')
      expect(result.current.supportLowFeeMode).toBe(false)
      act(() => {
        result.current.setFeeOptionIndex(3)
      })
      act(() => {
        result.current.adjustFeeRateInput('0.5')
      })
      expect(store.getState().ui.feeRateBar.feeRateInputVal).toBe('1')
    })

    it('keeps a Custom rate set while the quote cannot be read, and no lower than the floor', async () => {
      const { result, store } = renderSharedFeeBar(landed())
      await waitFor(() => expect(store.getState().ui.feeRateBar.feeRate).toBe(1))
      expect(result.current.feeOptions.map(result.current.isCustomOption)).toEqual([true])

      act(() => {
        result.current.setFeeOptionIndex(3)
      })
      expect(store.getState().ui.feeRateBar).toMatchObject({
        feeOptionIndex: 3,
        showCustomInput: true,
      })
      act(() => {
        result.current.adjustFeeRateInput('5')
      })
      await waitFor(() => expect(store.getState().ui.feeRateBar.feeRate).toBe(5))
      await act(async () => {})
      expect(store.getState().ui.feeRateBar.feeRate).toBe(5)

      // Low-fee mode cannot apply without a loaded quote.
      expect(result.current.supportLowFeeMode).toBe(false)
      act(() => {
        result.current.adjustFeeRateInput('0.5')
      })
      expect(store.getState().ui.feeRateBar.feeRateInputVal).toBe('1')
      await waitFor(() => expect(store.getState().ui.feeRateBar.feeRate).toBe(1))
    })

    it('takes a rate typed while a tier was selected as Custom once the quote cannot be read', async () => {
      const { result, rerender, store } = renderSharedFeeBar(landed(qbitFeeSummary()))
      await waitFor(() => expect(result.current.feeOptions).toHaveLength(4))
      act(() => {
        result.current.setFeeOptionIndex(0)
      })
      expect(store.getState().ui.feeRateBar).toMatchObject({
        feeOptionIndex: 0,
        feeRateInputVal: '1',
      })

      rerender({ quote: landed() })
      // The Custom tile now stands first, where Slow stood; it is not Slow.
      act(() => {
        result.current.adjustFeeRateInput('0')
      })
      expect(store.getState().ui.feeRateBar).toMatchObject({
        feeOptionIndex: 3,
        feeRateInputVal: '0',
      })
      act(() => {
        result.current.adjustFeeRateInput('5')
      })

      await waitFor(() =>
        expect(store.getState().ui.feeRateBar).toMatchObject({ feeOptionIndex: 3, feeRate: 5 })
      )
    })

    it('offers nothing to select in a read-only bar whose quote cannot be read', () => {
      const wallet = createWalletMock()
      const { wrapper } = createHookTestHarness({ wallet })
      const quote: SharedQuote = landed()

      const { result } = renderHook(() => useFeeRateBarLogic({ readonly: true, quote }), {
        wrapper,
      })

      expect(result.current.feeOptions).toEqual([])
      expect(result.current.feeEstimateUnavailable).toBe(true)
    })

    it('allows a Custom rate below 1 only once a low-fee read for the quote succeeds', async () => {
      const { result, rerender, store, wallet } = renderSharedFeeBar({ status: 'loading' })
      let rejectLowFee!: (error: Error) => void
      wallet.getLowFeeSummary.mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectLowFee = reject
        })
      )
      act(() => {
        result.current.setFeeOptionIndex(3)
      })

      rerender({ quote: landed(noMetadataSummary([2, 3, 4])) })
      // Its low-fee read is pending: no Sub 1 tier yet.
      expect(result.current.supportLowFeeMode).toBe(false)
      act(() => {
        result.current.adjustFeeRateInput('0.5')
      })
      expect(store.getState().ui.feeRateBar.feeRateInputVal).toBe('1')

      // It failed: the quote's own rates, and still no Sub 1 tier.
      await act(async () => {
        rejectLowFee(new Error('explorer down'))
      })
      expect(feeRates(result.current.feeOptions)).toEqual([2, 3, 4, 0])
      expect(result.current.supportLowFeeMode).toBe(false)
      act(() => {
        result.current.adjustFeeRateInput('0.5')
      })
      expect(store.getState().ui.feeRateBar.feeRateInputVal).toBe('1')
    })

    it('allows a Custom rate below 1 only once low-fee mode applies to a loaded quote', async () => {
      const { result, rerender, store, wallet } = renderSharedFeeBar({ status: 'loading' })
      wallet.getLowFeeSummary.mockResolvedValue(lowFeeSummary([0.5, 0.8]))
      act(() => {
        result.current.setFeeOptionIndex(3)
      })
      await waitFor(() => expect(store.getState().ui.feeRateBar.feeOptionIndex).toBe(3))

      expect(result.current.supportLowFeeMode).toBe(false)
      act(() => {
        result.current.adjustFeeRateInput('0.5')
      })
      expect(store.getState().ui.feeRateBar.feeRateInputVal).toBe('1')

      rerender({ quote: landed(noMetadataSummary([2, 3, 4])) })
      await waitFor(() => expect(result.current.supportLowFeeMode).toBe(true))
      act(() => {
        result.current.adjustFeeRateInput('0.5')
      })
      expect(store.getState().ui.feeRateBar.feeRateInputVal).toBe('0.5')
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
      const quote = landed(summary)

      const { result } = renderHook(() => useFeeRateBarLogic({ quote }), { wrapper })
      await waitFor(() => {
        expect(result.current.feeOptions.map(option => option.feeRate)).toEqual([0.8, 3, 4, 0])
      })
      expect(result.current.supportLowFeeMode).toBe(true)
      expect(summary).toEqual(before)
      expect(wallet.getFeeSummary).not.toHaveBeenCalled()
    })

    describe('records the read and option its rate came from', () => {
      it('names a read apart from every read of an earlier page, whose fee-bar store is saved', async () => {
        const names: string[] = []
        for (const _page of [1, 2]) {
          // A page loads its modules afresh.
          vi.resetModules()
          const helpers = await import('./testHelpers')
          const { useFeeQuoteRead } = await import('../../src/ui-hooks/useFeeRateBarLogic')
          const harness = helpers.createHookTestHarness()
          const { result } = renderHook(() => useFeeQuoteRead(), { wrapper: harness.wrapper })
          await waitFor(() => expect(result.current.status).toBe('loaded'))
          if (result.current.status === 'loaded') names.push(result.current.read)
        }

        expect(names).toHaveLength(2)
        expect(names[0]).not.toBe(names[1])
      })

      type Store = ReturnType<typeof renderSharedFeeBar>['store']
      const origin = (store: Store, quote: SharedQuote) =>
        feeRateOrigin(store.getState().ui.feeRateBar, quote)

      it('records nothing while the quote loads', async () => {
        const quote: SharedQuote = { status: 'loading' }
        const { store } = renderSharedFeeBar(quote)
        await act(async () => {})

        expect(store.getState().ui.feeRateBar).toMatchObject({ feeRate: 1, feeRateSource: null })
        expect(origin(store, quote)).toBe('pending')
      })

      it('records the read and tier a rate was chosen from', async () => {
        const quote = landed(qbitFeeSummary())
        const { store } = renderSharedFeeBar(quote)

        await waitFor(() => expect(origin(store, quote)).toBe('quote'))
        expect(store.getState().ui.feeRateBar).toMatchObject({
          feeRate: 2,
          feeRateSource: { quoteRead: quote.read, optionIndex: 1 },
        })
        // Not from a newer read of the same quote, nor while one loads.
        expect(origin(store, landed(qbitFeeSummary()))).toBe('pending')
        expect(origin(store, { status: 'loading' })).toBe('pending')
      })

      it('records the source of a tier whose rate is already the store’s', async () => {
        // Normal at 1 bit/vB, the store's default rate.
        const summary = qbitFeeSummary()
        const quote = landed({
          ...summary,
          list: summary.list.map(tier => ({ ...tier, feeRate: 1 })),
        })
        const { store } = renderSharedFeeBar(quote)

        await waitFor(() => expect(origin(store, quote)).toBe('quote'))
        expect(store.getState().ui.feeRateBar.feeRate).toBe(1)
      })

      it('records nothing while the low-fee read of a quote without metadata is pending', async () => {
        // On mainnet, where low-fee mode is configured.
        const { store, wallet, rerender } = renderSharedFeeBar({ status: 'loading' })
        let resolveLowFee!: (summary: ReturnType<typeof lowFeeSummary>) => void
        wallet.getLowFeeSummary.mockReturnValue(
          new Promise(resolve => {
            resolveLowFee = resolve
          })
        )
        const quote = landed(noMetadataSummary([2, 3, 4]))
        rerender({ quote })
        await waitFor(() => expect(wallet.getLowFeeSummary).toHaveBeenCalled())

        expect(store.getState().ui.feeRateBar.feeRateSource).toBeNull()
        expect(origin(store, quote)).toBe('pending')

        await act(async () => {
          resolveLowFee(lowFeeSummary([0.5, 0.8]))
        })
        await waitFor(() => expect(origin(store, quote)).toBe('quote'))
        expect(store.getState().ui.feeRateBar.feeRate).toBe(3)
      })

      it('records the read of a quote without metadata where low-fee mode is not configured', async () => {
        const wallet = createWalletMock()
        const harness = createHookTestHarness({ wallet })
        harness.store.dispatch(
          settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 })
        )
        const quote = landed(noMetadataSummary([2, 3, 4]))
        renderHook(() => useFeeRateBarLogic({ quote }), { wrapper: harness.wrapper })

        await waitFor(() => expect(origin(harness.store, quote)).toBe('quote'))
        expect(harness.store.getState().ui.feeRateBar.feeRate).toBe(3)
        expect(wallet.getLowFeeSummary).not.toHaveBeenCalled()
      })

      it('records the read that failed with the relay floor it uses', async () => {
        const { store, rerender } = renderSharedFeeBar({ status: 'loading' })
        // Fast at 40, as an earlier quote offered it.
        act(() => {
          store.dispatch(uiActions.updateFeeRateBar({ feeRate: 40, feeOptionIndex: 2 }))
        })
        const quote = landed()
        rerender({ quote })

        await waitFor(() => expect(origin(store, quote)).toBe('quote'))
        expect(store.getState().ui.feeRateBar).toMatchObject({
          feeRate: 1,
          feeRateSource: { quoteRead: quote.read, optionIndex: 2 },
        })
      })

      it('records no source for a fallback rate when the quote does not offer the selected tier', async () => {
        const { store, rerender } = renderSharedFeeBar({ status: 'loading' })
        // Fast at 40, as an earlier quote offered it.
        act(() => {
          store.dispatch(uiActions.updateFeeRateBar({ feeRate: 40, feeOptionIndex: 2 }))
        })
        const summary = qbitFeeSummary()
        const quote = landed({ ...summary, list: summary.list.slice(0, 2) })
        rerender({ quote })

        // Normal's rate stands in for Fast, which this quote does not list.
        await waitFor(() => expect(store.getState().ui.feeRateBar.feeRate).toBe(2))
        expect(store.getState().ui.feeRateBar.feeRateSource).toBeNull()
        expect(origin(store, quote)).toBe('pending')
      })

      it('records no source for a fallback rate when the quote lists no tiers', async () => {
        const { store, rerender } = renderSharedFeeBar({ status: 'loading' })
        // Normal at 40, as an earlier quote offered it.
        act(() => {
          store.dispatch(uiActions.updateFeeRateBar({ feeRate: 40, feeOptionIndex: 1 }))
        })
        const quote = landed({ ...qbitFeeSummary(), list: [] })
        rerender({ quote })

        // The default of 1 bit/vB stands in.
        await waitFor(() => expect(store.getState().ui.feeRateBar.feeRate).toBe(1))
        expect(store.getState().ui.feeRateBar.feeRateSource).toBeNull()
        expect(origin(store, quote)).toBe('pending')
      })

      it('records no source for a Custom rate', async () => {
        const quote = landed(qbitFeeSummary())
        const { result, store } = renderSharedFeeBar(quote)
        await waitFor(() => expect(origin(store, quote)).toBe('quote'))

        act(() => {
          result.current.adjustFeeRateInput('7')
        })

        await waitFor(() => expect(store.getState().ui.feeRateBar.feeRate).toBe(7))
        expect(store.getState().ui.feeRateBar.feeRateSource).toBeNull()
        expect(origin(store, quote)).toBe('custom')
      })

      it('records the earlier read for a tier selected while a newer one loads', async () => {
        const first = landed(qbitFeeSummary())
        const { result, rerender, store } = renderSharedFeeBar(first)
        await waitFor(() => expect(origin(store, first)).toBe('quote'))

        rerender({ quote: { status: 'loading' } })
        act(() => {
          result.current.setFeeOptionIndex(2)
        })
        await waitFor(() => expect(store.getState().ui.feeRateBar.feeRate).toBe(3))
        expect(store.getState().ui.feeRateBar.feeRateSource).toEqual({
          quoteRead: first.read,
          optionIndex: 2,
        })

        const second = landed(qbitFeeSummary('unavailable'))
        rerender({ quote: second })
        await waitFor(() => expect(origin(store, second)).toBe('quote'))
      })

      it('records nothing from a read-only bar', async () => {
        const wallet = createWalletMock()
        const harness = createHookTestHarness({ wallet })
        const quote = landed(qbitFeeSummary())
        renderHook(() => useFeeRateBarLogic({ readonly: true, quote }), {
          wrapper: harness.wrapper,
        })
        await act(async () => {})

        expect(harness.store.getState().ui.feeRateBar).toMatchObject({
          feeRate: 1,
          feeRateSource: null,
        })
      })
    })
  })
})
