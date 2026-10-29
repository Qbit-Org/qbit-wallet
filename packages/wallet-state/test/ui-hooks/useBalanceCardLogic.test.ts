import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

describe('useBalanceCardLogic before a balance read', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** The card for `address`, whose balance reads go to `wallet`, with none stored yet. */
  function renderUnreadBalanceCard(wallet = createWalletMock()) {
    const harness = createHookTestHarness({ wallet })
    harness.store.dispatch(
      accountActions.setCurrent({
        address,
        pubkey: '11'.repeat(32),
        type: 'Qbit HD Key Tree',
      } as any)
    )
    return {
      ...harness,
      result: renderHook(() => useBalanceCardLogic(), { wrapper: harness.wrapper }).result,
    }
  }

  const expectUnknown = (result: ReturnType<typeof renderUnreadBalanceCard>['result']) => {
    expect(result.current.isCurrentChainBalance).toBe(false)
    expect(result.current.balanceValue).toBe('--')
    expect(result.current.availableBalance).toBeNull()
    expect(result.current.unavailableBalance).toBeNull()
    expect(result.current.availableAmount).toBe('--')
    expect(result.current.unavailableAmount).toBe('--')
    expect(result.current.utxoLimitExceeded).toBe(false)
    // Nor is the unknown blamed on the explorer's limit.
    expect(result.current.balanceSplitUnknown).toBe(false)
  }

  it('shows the balance as unknown, not 0, until a read for the account succeeds', () => {
    const { store, result } = renderUnreadBalanceCard()
    expectUnknown(result)

    // A balance read for another account does not count for this one.
    act(() => {
      store.dispatch(
        accountActions.setBalanceV2({
          address: 'qbit-another-account',
          balance: {
            availableBalance: 5_000,
            unavailableBalance: 0,
            totalBalance: 5_000,
            chainType: ChainType.QBIT_MAINNET,
          },
        })
      )
    })
    expectUnknown(result)
  })

  it('keeps it unknown while every read fails, and shows a 0 a read returns as 0', async () => {
    vi.useFakeTimers()
    const wallet = Object.assign(createWalletMock(), {
      getAddressSummary: vi.fn().mockResolvedValue({ totalSatoshis: 0, spendableSatoshis: 0 }),
      getAddressBalanceV2: vi.fn().mockRejectedValue(new Error('explorer unreachable')),
    })
    const { result } = renderUnreadBalanceCard(wallet)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(wallet.getAddressBalanceV2).toHaveBeenCalledTimes(3)
    expectUnknown(result)

    wallet.getAddressBalanceV2.mockResolvedValue({
      availableBalance: 0,
      unavailableBalance: 0,
      totalBalance: 0,
      immatureBalance: 0,
      pendingBalance: 0,
      chainType: ChainType.QBIT_MAINNET,
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current.isCurrentChainBalance).toBe(true)
    expect(result.current.balanceValue).toBe('0.00000000')
    expect(result.current.availableAmount).toBe('0.00000000')
    expect(result.current.unavailableAmount).toBe('0.00000000')
  })

  it('names the explorer limit only when the read says the account is over it', () => {
    // While a broadcast holds the send guard the split is unknown too, for
    // another reason than the explorer's limit.
    const result = renderBalanceCard({
      availableBalance: null,
      unavailableBalance: 91_000_000,
      totalBalance: 91_000_000,
      immatureBalance: null,
      pendingBalance: null,
    })

    expect(result.current.balanceValue).toBe('0.91000000')
    expect(result.current.availableAmount).toBe('--')
    expect(result.current.unavailableAmount).toBe('--')
    expect(result.current.utxoLimitExceeded).toBe(false)
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

describe('useBalanceCardLogic unread, failed, over-limit and guard-held balances', () => {
  const overLimitRead = {
    availableBalance: null,
    unavailableBalance: 91_000_000,
    totalBalance: 91_000_000,
    immatureBalance: null,
    pendingBalance: null,
    utxoLimitExceeded: true,
    chainType: ChainType.QBIT_MAINNET,
  }
  // The shape a balance read reports when it stopped waiting for a send
  // guard a broadcast holds: the split is unknown, but not for the
  // explorer's limit.
  const guardHeldRead = {
    availableBalance: null,
    unavailableBalance: 91_000_000,
    totalBalance: 91_000_000,
    immatureBalance: null,
    pendingBalance: null,
    chainType: ChainType.QBIT_MAINNET,
  }

  type Card = ReturnType<typeof useBalanceCardLogic>
  const expectNoError = (card: Card) => {
    expect(card.balanceLoadFailed).toBe(false)
    expect(card.balanceRefreshFailed).toBe(false)
    expect(card.balanceErrorText).toBeUndefined()
  }

  it('shows `--` and no error while the first read is still running', async () => {
    let answer!: (value: unknown) => void
    const getAddressSummary = vi.fn(() => new Promise((resolve) => (answer = resolve)))
    const { result } = renderWithExplorer({ getAddressSummary })

    expect(result.current.card.balanceValue).toBe('--')
    expectNoError(result.current.card)

    act(() => {
      result.current.card.retryBalance()
    })
    expect(result.current.card.isRetryingBalance).toBe(true)
    expect(result.current.card.balanceValue).toBe('--')
    expect(result.current.card.availableAmount).toBe('--')
    expect(result.current.card.unavailableAmount).toBe('--')
    expectNoError(result.current.card)

    await act(async () => {
      answer(summary)
    })
    await waitFor(() => expect(result.current.card.isRetryingBalance).toBe(false))
    expect(result.current.card.balanceValue).toBe('0.00005000')
    expectNoError(result.current.card)
  })

  it('shows the load error, and `--` rather than 0, when the first read fails', async () => {
    const { result } = renderWithExplorer({
      getAddressSummary: vi.fn().mockResolvedValue(summary),
      getAddressBalanceV2: vi.fn().mockRejectedValue(new Error('explorer unreachable')),
    })

    await retry(result)

    expect(result.current.card.balanceLoadFailed).toBe(true)
    expect(result.current.card.balanceErrorText).toBe('balance_load_error')
    expect(result.current.card.isCurrentChainBalance).toBe(false)
    expect(result.current.card.balanceValue).toBe('--')
    expect(result.current.card.availableAmount).toBe('--')
    expect(result.current.card.unavailableAmount).toBe('--')
    expect(result.current.card.utxoLimitExceeded).toBe(false)
    expect(result.current.card.balanceSplitUnknown).toBe(false)
  })

  it('keeps the last measured balance and split, marked out of date, when a later refresh fails', async () => {
    const { result } = renderWithExplorer({
      getAddressSummary: vi
        .fn()
        .mockResolvedValueOnce(summary)
        .mockRejectedValue(new Error('explorer down')),
    })

    await retry(result)
    expectNoError(result.current.card)
    await retry(result)

    expect(result.current.card.balanceLoadFailed).toBe(false)
    expect(result.current.card.balanceRefreshFailed).toBe(true)
    expect(result.current.card.balanceErrorText).toBe('balance_refresh_error')
    expect(result.current.card.balanceValue).toBe('0.00005000')
    expect(result.current.card.availableAmount).toBe('0.00005000')
    expect(result.current.card.unavailableAmount).toBe('0.00000000')
    expect(result.current.card.utxoLimitExceeded).toBe(false)
  })

  it('names the explorer limit, with no error, for an over-limit read', async () => {
    const { result } = renderWithExplorer({
      getAddressSummary: vi.fn().mockResolvedValue(summary),
      getAddressBalanceV2: vi.fn().mockResolvedValue(overLimitRead),
    })

    await retry(result)

    expectNoError(result.current.card)
    expect(result.current.card.balanceValue).toBe('0.91000000')
    expect(result.current.card.utxoLimitExceeded).toBe(true)
    expect(result.current.card.balanceSplitUnknown).toBe(true)
    expect(result.current.card.availableAmount).toBe('--')
    expect(result.current.card.unavailableAmount).toBe('--')
  })

  it('shows the split as `--` with no explorer note and no error while a broadcast holds the send guard', async () => {
    const { result } = renderWithExplorer({
      getAddressSummary: vi.fn().mockResolvedValue(summary),
      getAddressBalanceV2: vi.fn().mockResolvedValue(guardHeldRead),
    })

    await retry(result)

    expectNoError(result.current.card)
    expect(result.current.card.isCurrentChainBalance).toBe(true)
    expect(result.current.card.balanceValue).toBe('0.91000000')
    expect(result.current.card.availableAmount).toBe('--')
    expect(result.current.card.unavailableAmount).toBe('--')
    expect(result.current.card.utxoLimitExceeded).toBe(false)
    expect(result.current.card.balanceSplitUnknown).toBe(false)
  })

  it('clears a failed first read once a guard-held read succeeds', async () => {
    const { result } = renderWithExplorer({
      getAddressSummary: vi.fn().mockResolvedValue(summary),
      getAddressBalanceV2: vi
        .fn()
        .mockRejectedValueOnce(new Error('explorer unreachable'))
        .mockResolvedValue(guardHeldRead),
    })

    await retry(result)
    expect(result.current.card.balanceLoadFailed).toBe(true)

    await retry(result)
    expectNoError(result.current.card)
    expect(result.current.card.balanceValue).toBe('0.91000000')
    expect(result.current.card.availableAmount).toBe('--')
    expect(result.current.card.balanceSplitUnknown).toBe(false)
  })
})

describe("useBalanceCardLogic past the explorer's limit, with the background's split", () => {
  // The background's split from the send screen's read of the outputs, while
  // the address statistics still read as they did for it.
  const overLimitSplit = {
    availableBalance: 60_000_000,
    unavailableBalance: 31_000_000,
    totalBalance: 91_000_000,
    immatureBalance: null,
    pendingBalance: null,
    utxoLimitExceeded: true,
  }
  const overLimitUnknown = {
    ...overLimitSplit,
    availableBalance: null,
    unavailableBalance: 91_000_000,
  }

  it('shows the split the background reports', () => {
    const result = renderBalanceCard(overLimitSplit)

    expect(result.current.balanceValue).toBe('0.91000000')
    expect(result.current.availableBalance).toBe(60_000_000)
    expect(result.current.unavailableBalance).toBe(31_000_000)
    expect(result.current.availableAmount).toBe('0.60000000')
    expect(result.current.unavailableAmount).toBe('0.31000000')
    expect(result.current.balanceSplitUnknown).toBe(false)
    // The total still comes from the address statistics.
    expect(result.current.utxoLimitExceeded).toBe(true)
  })

  it('goes back to `--` when a later read has no split', async () => {
    const { result } = renderWithExplorer({
      getAddressSummary: vi.fn().mockResolvedValue(summary),
      getAddressBalanceV2: vi
        .fn()
        .mockResolvedValueOnce({ ...overLimitSplit, chainType: ChainType.QBIT_MAINNET })
        .mockResolvedValue({ ...overLimitUnknown, chainType: ChainType.QBIT_MAINNET }),
    })

    await retry(result)
    expect(result.current.card.availableAmount).toBe('0.60000000')

    await retry(result)
    expect(result.current.card.availableAmount).toBe('--')
    expect(result.current.card.unavailableAmount).toBe('--')
    expect(result.current.card.balanceSplitUnknown).toBe(true)
  })

  it("does not show another network's split", () => {
    const result = renderBalanceCard({ ...overLimitSplit, chainType: ChainType.QBIT_TESTNET4 })

    expect(result.current.balanceValue).toBe('--')
    expect(result.current.availableAmount).toBe('--')
    expect(result.current.unavailableAmount).toBe('--')
  })

  it("does not show another account's split", () => {
    const harness = createHookTestHarness()
    harness.store.dispatch(
      accountActions.setCurrent({
        address,
        pubkey: '11'.repeat(32),
        type: 'Qbit HD Key Tree',
      } as any)
    )
    harness.store.dispatch(
      accountActions.setBalanceV2({
        address: 'qbit-another-account',
        balance: { ...overLimitSplit, chainType: ChainType.QBIT_MAINNET } as any,
      })
    )
    harness.store.dispatch(
      accountActions.setBalanceV2({
        address,
        balance: { ...overLimitUnknown, chainType: ChainType.QBIT_MAINNET } as any,
      })
    )
    const { result } = renderHook(() => useBalanceCardLogic(), { wrapper: harness.wrapper })

    expect(result.current.balanceValue).toBe('0.91000000')
    expect(result.current.availableAmount).toBe('--')
    expect(result.current.unavailableAmount).toBe('--')
  })
})
