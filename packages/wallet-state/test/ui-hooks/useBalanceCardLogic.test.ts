import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChainType } from '@qbit/wallet-types'

import { useFetchBalanceCallback } from '../../src/hooks/accounts'
import { useBalanceCardLogic } from '../../src/ui-hooks/useBalanceCardLogic'
import { accountActions } from '../../src/reducers/accounts'
import { createHookTestHarness, createWalletMock } from './testHelpers'

const address = 'qbit-many-outputs'

function renderBalanceCard(balance: Record<string, unknown>) {
  const harness = createHookTestHarness()
  harness.store.dispatch(
    accountActions.setCurrent({ address, pubkey: '11'.repeat(32), type: 'Qbit HD Key Tree' } as any)
  )
  harness.store.dispatch(
    accountActions.setBalanceV2({
      address,
      balance: { chainType: ChainType.QBIT_MAINNET, ...balance } as any,
    })
  )
  return renderHook(() => useBalanceCardLogic(), { wrapper: harness.wrapper }).result
}

describe('useBalanceCardLogic', () => {
  it('shows the statistics total with a label when the explorer cannot list the outputs', () => {
    const result = renderBalanceCard({
      availableBalance: null,
      unavailableBalance: 91_000_000,
      totalBalance: 91_000_000,
      immatureBalance: null,
      pendingBalance: null,
      utxoLimitExceeded: true,
    })

    expect(result.current.isCurrentChainBalance).toBe(true)
    expect(result.current.balanceValue).toBe('0.91000000')
    expect(result.current.utxoLimitExceeded).toBe(true)
    expect(result.current.utxoLimitExceededText).toBe('utxo_limit_exceeded_balance')
  })

  it('shows the available and unavailable split as unknown, not 0, past the limit (#341)', () => {
    // The shape getQbitSpendableBalanceV2 reports for an over-limit address.
    const result = renderBalanceCard({
      availableBalance: null,
      unavailableBalance: 91_000_000,
      totalBalance: 91_000_000,
      immatureBalance: null,
      pendingBalance: null,
      utxoLimitExceeded: true,
    })

    expect(result.current.balanceValue).toBe('0.91000000')
    expect(result.current.totalBalance).toBe(91_000_000)
    expect(result.current.availableBalance).toBeNull()
    expect(result.current.unavailableBalance).toBeNull()
    expect(result.current.availableAmount).toBe('--')
    expect(result.current.unavailableAmount).toBe('--')
    expect(result.current.balanceSplitUnknown).toBe(true)
    expect(result.current.balanceSplitUnknownText).toBe('utxo_limit_exceeded_balance_detail')
  })

  it('does not report an unknown split for a balance from another network', () => {
    const result = renderBalanceCard({
      availableBalance: null,
      unavailableBalance: 91_000_000,
      totalBalance: 91_000_000,
      utxoLimitExceeded: true,
      chainType: ChainType.QBIT_TESTNET4,
    })

    expect(result.current.isCurrentChainBalance).toBe(false)
    expect(result.current.balanceValue).toBe('--')
    expect(result.current.utxoLimitExceeded).toBe(false)
    expect(result.current.balanceSplitUnknown).toBe(false)
    expect(result.current.availableAmount).toBe('--')
  })

  it('shows no label for an ordinary balance', () => {
    const result = renderBalanceCard({
      availableBalance: 5_000,
      unavailableBalance: 0,
      totalBalance: 5_000,
    })

    expect(result.current.balanceValue).toBe('0.00005000')
    expect(result.current.utxoLimitExceeded).toBe(false)
    expect(result.current.balanceSplitUnknown).toBe(false)
    expect(result.current.availableAmount).toBe('0.00005000')
    expect(result.current.unavailableAmount).toBe('0.00000000')
  })

  it('keeps a measured 0 available as 0', () => {
    const result = renderBalanceCard({
      availableBalance: 0,
      unavailableBalance: 7_000,
      totalBalance: 7_000,
      immatureBalance: 7_000,
      pendingBalance: 0,
    })

    expect(result.current.availableBalance).toBe(0)
    expect(result.current.availableAmount).toBe('0.00000000')
    expect(result.current.unavailableAmount).toBe('0.00007000')
    expect(result.current.balanceSplitUnknown).toBe(false)
  })
})

const summary = { address, totalSatoshis: 5_000, spendableSatoshis: 5_000 }
const balance = {
  availableBalance: 5_000,
  unavailableBalance: 0,
  totalBalance: 5_000,
  chainType: ChainType.QBIT_MAINNET,
}

function renderWithExplorer(explorer: {
  getAddressSummary: ReturnType<typeof vi.fn>
  getAddressBalanceV2?: ReturnType<typeof vi.fn>
}) {
  const wallet = {
    ...createWalletMock(),
    getAddressBalanceV2: vi.fn().mockResolvedValue(balance),
    ...explorer,
  }
  const harness = createHookTestHarness({ wallet: wallet as any })
  harness.store.dispatch(
    accountActions.setCurrent({ address, pubkey: '11'.repeat(32), type: 'Qbit HD Key Tree' } as any)
  )
  const { result } = renderHook(
    () => ({ card: useBalanceCardLogic(), fetchBalance: useFetchBalanceCallback() }),
    { wrapper: harness.wrapper }
  )
  return { result, wallet }
}

async function retry(result: { current: { card: ReturnType<typeof useBalanceCardLogic> } }) {
  act(() => {
    result.current.card.retryBalance()
  })
  await waitFor(() => expect(result.current.card.isRetryingBalance).toBe(false))
}

describe('useBalanceCardLogic error state', () => {
  it('shows a load error instead of a zero balance when the explorer is down', async () => {
    const { result } = renderWithExplorer({
      getAddressSummary: vi.fn().mockRejectedValue(new Error('explorer down')),
    })

    await retry(result)

    expect(result.current.card.balanceLoadFailed).toBe(true)
    expect(result.current.card.balanceRefreshFailed).toBe(false)
    expect(result.current.card.balanceErrorText).toBe('balance_load_error')

    const expanded = result.current.card.isDetailExpanded
    act(() => {
      result.current.card.handleExpandToggle()
    })
    expect(result.current.card.isDetailExpanded).toBe(expanded)
  })

  it('clears the error when a retry reaches the explorer', async () => {
    const { result } = renderWithExplorer({
      getAddressSummary: vi
        .fn()
        .mockRejectedValueOnce(new Error('explorer down'))
        .mockResolvedValue(summary),
    })

    await retry(result)
    expect(result.current.card.balanceLoadFailed).toBe(true)

    await retry(result)
    expect(result.current.card.balanceLoadFailed).toBe(false)
    expect(result.current.card.balanceErrorText).toBeUndefined()
    expect(result.current.card.balanceValue).toBe('0.00005000')
  })

  it('keeps the last balance, marked out of date, when a later refresh fails', async () => {
    const { result } = renderWithExplorer({
      getAddressSummary: vi
        .fn()
        .mockResolvedValueOnce(summary)
        .mockRejectedValue(new Error('explorer down')),
    })

    await retry(result)
    await retry(result)

    expect(result.current.card.balanceLoadFailed).toBe(false)
    expect(result.current.card.balanceRefreshFailed).toBe(true)
    expect(result.current.card.balanceErrorText).toBe('balance_refresh_error')
    expect(result.current.card.balanceValue).toBe('0.00005000')
  })

  it('keeps an over-limit total and its unknown split when a later refresh fails', async () => {
    const { result } = renderWithExplorer({
      getAddressSummary: vi
        .fn()
        .mockResolvedValueOnce(summary)
        .mockRejectedValue(new Error('explorer down')),
      getAddressBalanceV2: vi.fn().mockResolvedValue({
        availableBalance: null,
        unavailableBalance: 91_000_000,
        totalBalance: 91_000_000,
        immatureBalance: null,
        pendingBalance: null,
        utxoLimitExceeded: true,
        chainType: ChainType.QBIT_MAINNET,
      }),
    })

    await retry(result)
    await retry(result)

    expect(result.current.card.balanceLoadFailed).toBe(false)
    expect(result.current.card.balanceRefreshFailed).toBe(true)
    expect(result.current.card.balanceValue).toBe('0.91000000')
    expect(result.current.card.utxoLimitExceeded).toBe(true)
    expect(result.current.card.balanceSplitUnknown).toBe(true)
    expect(result.current.card.availableAmount).toBe('--')
    expect(result.current.card.unavailableAmount).toBe('--')
  })

  it('runs one retry at a time', async () => {
    let fail!: (error: Error) => void
    const getAddressSummary = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        })
    )
    const { result } = renderWithExplorer({ getAddressSummary })

    act(() => {
      result.current.card.retryBalance()
      result.current.card.retryBalance()
    })
    expect(result.current.card.isRetryingBalance).toBe(true)
    expect(getAddressSummary).toHaveBeenCalledTimes(1)

    await act(async () => {
      fail(new Error('explorer down'))
    })
    expect(result.current.card.isRetryingBalance).toBe(false)
    expect(result.current.card.balanceLoadFailed).toBe(true)
  })

  it('does not let an older failed refresh override a newer success', async () => {
    const pending: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = []
    const getAddressSummary = vi.fn(
      () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
    )
    const { result } = renderWithExplorer({ getAddressSummary })

    let older!: Promise<void>
    let newer!: Promise<void>
    act(() => {
      older = result.current.fetchBalance()
      newer = result.current.fetchBalance()
    })

    await act(async () => {
      pending[1].resolve(summary)
      await newer
    })
    await act(async () => {
      pending[0].reject(new Error('explorer timed out'))
      await older.catch(() => undefined)
    })

    expect(result.current.card.balanceLoadFailed).toBe(false)
    expect(result.current.card.balanceRefreshFailed).toBe(false)
    expect(result.current.card.balanceValue).toBe('0.00005000')
  })
})
