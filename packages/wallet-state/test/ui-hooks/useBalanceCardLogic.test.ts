import { act, render, renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChainType } from '@qbit/wallet-types'

import { useFetchBalanceCallback } from '../../src/hooks/accounts'
import { startBalancePoll, useBalanceCardLogic } from '../../src/ui-hooks/useBalanceCardLogic'
import { accountActions } from '../../src/reducers/accounts'
import { settingsActions } from '../../src/reducers/settings'
import { unhandledRejectionsDuring } from '../../../../tests/support/unhandledRejections'
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
    // Not the note for outputs still being read: the explorer refused to list them.
    expect(result.current.utxoReadIncomplete).toBe(false)
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
    expect(result.current.utxoReadIncomplete).toBe(false)
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
      getAddressBalanceV2: vi.fn().mockRejectedValue(new Error('explorer unreachable')),
    })
    const { result } = renderUnreadBalanceCard(wallet)

    // Failed reads back off: 10 s after the first failure, 20 s after the second.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000)
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
      await vi.advanceTimersByTimeAsync(40_000)
    })
    expect(wallet.getAddressBalanceV2).toHaveBeenCalledTimes(4)
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
    expect(result.current.utxoReadIncomplete).toBe(false)
  })
})

const balance = {
  availableBalance: 5_000,
  unavailableBalance: 0,
  totalBalance: 5_000,
  chainType: ChainType.QBIT_MAINNET,
}
// The background read the address statistics but not every output yet (an
// account with thousands of them takes several reads): the total is
// measured, the split is not.
const incompleteRead = {
  availableBalance: null,
  unavailableBalance: 91_000_000,
  totalBalance: 91_000_000,
  immatureBalance: null,
  pendingBalance: null,
  utxoReadIncomplete: true,
  chainType: ChainType.QBIT_MAINNET,
}
// The same, but the read of the outputs stopped on a failure (the listing or
// a transaction lookup failed) rather than running out of time.
const failedRead = { ...incompleteRead, utxoReadFailed: true }
// The same account once every output is read.
const fullRead = {
  availableBalance: 60_000_000,
  unavailableBalance: 31_000_000,
  totalBalance: 91_000_000,
  immatureBalance: 0,
  pendingBalance: 31_000_000,
  chainType: ChainType.QBIT_MAINNET,
}

function renderWithExplorer(explorer: { getAddressBalanceV2: ReturnType<typeof vi.fn> }) {
  const wallet = {
    ...createWalletMock(),
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
  return { result, wallet, store: harness.store }
}

async function retry(result: { current: { card: ReturnType<typeof useBalanceCardLogic> } }) {
  act(() => {
    result.current.card.retryBalance()
  })
  await waitFor(() => expect(result.current.card.isRetryingBalance).toBe(false))
}

/** Reads the background answers when the test says, in the order the test says. */
function pendingReads() {
  const pending: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = []
  const getAddressBalanceV2 = vi.fn(
    () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
  )
  return { pending, getAddressBalanceV2 }
}

describe('useBalanceCardLogic error state', () => {
  it('shows a load error instead of a zero balance when the explorer is down', async () => {
    const { result } = renderWithExplorer({
      getAddressBalanceV2: vi.fn().mockRejectedValue(new Error('explorer down')),
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
      getAddressBalanceV2: vi
        .fn()
        .mockRejectedValueOnce(new Error('explorer down'))
        .mockResolvedValue(balance),
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
      getAddressBalanceV2: vi
        .fn()
        .mockResolvedValueOnce(balance)
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
      getAddressBalanceV2: vi
        .fn()
        .mockResolvedValueOnce({
          availableBalance: null,
          unavailableBalance: 91_000_000,
          totalBalance: 91_000_000,
          immatureBalance: null,
          pendingBalance: null,
          utxoLimitExceeded: true,
          chainType: ChainType.QBIT_MAINNET,
        })
        .mockRejectedValue(new Error('explorer down')),
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
    const getAddressBalanceV2 = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        })
    )
    const { result } = renderWithExplorer({ getAddressBalanceV2 })

    act(() => {
      result.current.card.retryBalance()
      result.current.card.retryBalance()
    })
    expect(result.current.card.isRetryingBalance).toBe(true)
    expect(getAddressBalanceV2).toHaveBeenCalledTimes(1)

    await act(async () => {
      fail(new Error('explorer down'))
    })
    expect(result.current.card.isRetryingBalance).toBe(false)
    expect(result.current.card.balanceLoadFailed).toBe(true)
  })

  it('does not let an older failed refresh override a newer success', async () => {
    const { pending, getAddressBalanceV2 } = pendingReads()
    const { result } = renderWithExplorer({ getAddressBalanceV2 })

    let older!: Promise<void>
    let newer!: Promise<void>
    act(() => {
      older = result.current.fetchBalance()
      newer = result.current.fetchBalance()
    })

    // The newer read is one that could not finish reading the outputs.
    await act(async () => {
      pending[1].resolve(incompleteRead)
      await newer
    })
    await act(async () => {
      pending[0].reject(new Error('explorer timed out'))
      await older.catch(() => undefined)
    })

    expect(result.current.card.balanceLoadFailed).toBe(false)
    expect(result.current.card.balanceRefreshFailed).toBe(false)
    expect(result.current.card.balanceValue).toBe('0.91000000')
    expect(result.current.card.utxoReadIncomplete).toBe(true)
    expect(result.current.card.availableAmount).toBe('--')
  })

  it('shows an older refresh that succeeds after a newer one failed, marked out of date', async () => {
    const { pending, getAddressBalanceV2 } = pendingReads()
    const { result } = renderWithExplorer({ getAddressBalanceV2 })

    let older!: Promise<void>
    let newer!: Promise<void>
    act(() => {
      older = result.current.fetchBalance()
      newer = result.current.fetchBalance()
    })

    await act(async () => {
      pending[1].reject(new Error('explorer timed out'))
      await newer.catch(() => undefined)
    })
    expect(result.current.card.balanceLoadFailed).toBe(true)

    await act(async () => {
      pending[0].resolve(balance)
      await older
    })

    expect(result.current.card.balanceLoadFailed).toBe(false)
    expect(result.current.card.balanceRefreshFailed).toBe(true)
    expect(result.current.card.balanceErrorText).toBe('balance_refresh_error')
    expect(result.current.card.balanceValue).toBe('0.00005000')
  })

  it.each([
    ['a full answer finishing after a newer incomplete one', fullRead, incompleteRead, true],
    ['an incomplete answer finishing after a newer full one', incompleteRead, fullRead, false],
  ])('does not let %s change the newer one', async (_case, olderAnswer, newerAnswer, incomplete) => {
    const { pending, getAddressBalanceV2 } = pendingReads()
    const { result } = renderWithExplorer({ getAddressBalanceV2 })

    let older!: Promise<void>
    let newer!: Promise<void>
    act(() => {
      older = result.current.fetchBalance()
      newer = result.current.fetchBalance()
    })
    await act(async () => {
      pending[1].resolve(newerAnswer)
      await newer
    })
    await act(async () => {
      pending[0].resolve(olderAnswer)
      await older
    })

    expect(result.current.card.utxoReadIncomplete).toBe(incomplete)
    expect(result.current.card.balanceValue).toBe('0.91000000')
    expect(result.current.card.availableAmount).toBe(incomplete ? '--' : '0.60000000')
    expect(result.current.card.unavailableAmount).toBe(incomplete ? '--' : '0.31000000')
    expect(result.current.card.balanceErrorText).toBeUndefined()
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
    const getAddressBalanceV2 = vi.fn(() => new Promise((resolve) => (answer = resolve)))
    const { result } = renderWithExplorer({ getAddressBalanceV2 })

    expect(result.current.card.balanceLoading).toBe(true)
    expect(result.current.card.balanceValue).toBe('--')
    expectNoError(result.current.card)

    act(() => {
      result.current.card.retryBalance()
    })
    expect(result.current.card.isRetryingBalance).toBe(true)
    expect(result.current.card.balanceLoading).toBe(true)
    expect(result.current.card.balanceValue).toBe('--')
    expect(result.current.card.availableAmount).toBe('--')
    expect(result.current.card.unavailableAmount).toBe('--')
    expectNoError(result.current.card)

    await act(async () => {
      answer(balance)
    })
    await waitFor(() => expect(result.current.card.isRetryingBalance).toBe(false))
    expect(result.current.card.balanceLoading).toBe(false)
    expect(result.current.card.balanceValue).toBe('0.00005000')
    expectNoError(result.current.card)
  })

  it('shows the load error, and `--` rather than 0, when the first read fails', async () => {
    const { result } = renderWithExplorer({
      getAddressBalanceV2: vi.fn().mockRejectedValue(new Error('explorer unreachable')),
    })

    await retry(result)

    expect(result.current.card.balanceLoadFailed).toBe(true)
    expect(result.current.card.balanceErrorText).toBe('balance_load_error')
    expect(result.current.card.balanceLoading).toBe(false)
    expect(result.current.card.isCurrentChainBalance).toBe(false)
    expect(result.current.card.balanceValue).toBe('--')
    expect(result.current.card.availableAmount).toBe('--')
    expect(result.current.card.unavailableAmount).toBe('--')
    expect(result.current.card.utxoLimitExceeded).toBe(false)
    expect(result.current.card.balanceSplitUnknown).toBe(false)
    expect(result.current.card.utxoReadIncomplete).toBe(false)
  })

  it('keeps the last measured balance and split, marked out of date, when a later refresh fails', async () => {
    const { result } = renderWithExplorer({
      getAddressBalanceV2: vi
        .fn()
        .mockResolvedValueOnce(balance)
        .mockRejectedValue(new Error('explorer down')),
    })

    await retry(result)
    expectNoError(result.current.card)
    await retry(result)

    expect(result.current.card.balanceLoadFailed).toBe(false)
    expect(result.current.card.balanceRefreshFailed).toBe(true)
    expect(result.current.card.balanceErrorText).toBe('balance_refresh_error')
    expect(result.current.card.balanceLoading).toBe(false)
    expect(result.current.card.balanceValue).toBe('0.00005000')
    expect(result.current.card.availableAmount).toBe('0.00005000')
    expect(result.current.card.unavailableAmount).toBe('0.00000000')
    expect(result.current.card.utxoLimitExceeded).toBe(false)
  })

  it('names the explorer limit, with no error, for an over-limit read', async () => {
    const { result } = renderWithExplorer({
      getAddressBalanceV2: vi.fn().mockResolvedValue(overLimitRead),
    })

    await retry(result)

    expectNoError(result.current.card)
    expect(result.current.card.balanceLoading).toBe(false)
    expect(result.current.card.balanceValue).toBe('0.91000000')
    expect(result.current.card.utxoLimitExceeded).toBe(true)
    expect(result.current.card.balanceSplitUnknown).toBe(true)
    expect(result.current.card.availableAmount).toBe('--')
    expect(result.current.card.unavailableAmount).toBe('--')
  })

  it('shows the split as `--` with no explorer note and no error while a broadcast holds the send guard', async () => {
    const { result } = renderWithExplorer({
      getAddressBalanceV2: vi.fn().mockResolvedValue(guardHeldRead),
    })

    await retry(result)

    expectNoError(result.current.card)
    expect(result.current.card.isCurrentChainBalance).toBe(true)
    expect(result.current.card.balanceLoading).toBe(false)
    expect(result.current.card.balanceValue).toBe('0.91000000')
    expect(result.current.card.availableAmount).toBe('--')
    expect(result.current.card.unavailableAmount).toBe('--')
    expect(result.current.card.utxoLimitExceeded).toBe(false)
    expect(result.current.card.balanceSplitUnknown).toBe(false)
    expect(result.current.card.utxoReadIncomplete).toBe(false)
  })

  it('clears a failed first read once a guard-held read succeeds', async () => {
    const { result } = renderWithExplorer({
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

describe('useBalanceCardLogic while the outputs are still being read', () => {
  type Card = ReturnType<typeof useBalanceCardLogic>
  const expectIncomplete = (card: Card) => {
    expect(card.balanceLoading).toBe(false)
    expect(card.isCurrentChainBalance).toBe(true)
    expect(card.balanceValue).toBe('0.91000000')
    expect(card.utxoReadIncomplete).toBe(true)
    expect(card.utxoReadIncompleteText).toBe('balance_outputs_incomplete')
    expect(card.utxoReadIncompleteDetailText).toBe('balance_outputs_incomplete_detail')
    expect(card.availableBalance).toBeNull()
    expect(card.unavailableBalance).toBeNull()
    expect(card.availableAmount).toBe('--')
    expect(card.unavailableAmount).toBe('--')
    // Neither the explorer's limit nor a failed read.
    expect(card.utxoLimitExceeded).toBe(false)
    expect(card.balanceSplitUnknown).toBe(false)
    expect(card.balanceLoadFailed).toBe(false)
  }

  it('shows the total, with a note, and the split as `--` rather than the load error', async () => {
    const { result } = renderWithExplorer({
      getAddressBalanceV2: vi.fn().mockResolvedValue(incompleteRead),
    })

    await retry(result)

    expectIncomplete(result.current.card)
    expect(result.current.card.balanceRefreshFailed).toBe(false)
    expect(result.current.card.balanceErrorText).toBeUndefined()
  })

  it('clears the note once a read finishes the outputs', async () => {
    const { result } = renderWithExplorer({
      getAddressBalanceV2: vi
        .fn()
        .mockResolvedValueOnce(incompleteRead)
        .mockResolvedValueOnce(incompleteRead)
        .mockResolvedValue(fullRead),
    })

    await retry(result)
    expectIncomplete(result.current.card)
    await retry(result)
    expectIncomplete(result.current.card)
    await retry(result)

    expect(result.current.card.utxoReadIncomplete).toBe(false)
    expect(result.current.card.balanceValue).toBe('0.91000000')
    expect(result.current.card.availableAmount).toBe('0.60000000')
    expect(result.current.card.unavailableAmount).toBe('0.31000000')
    expect(result.current.card.balanceErrorText).toBeUndefined()
  })

  it('keeps the total and the note, marked out of date, when a later refresh fails', async () => {
    const { result } = renderWithExplorer({
      getAddressBalanceV2: vi
        .fn()
        .mockResolvedValueOnce(incompleteRead)
        .mockRejectedValue(new Error('explorer down')),
    })

    await retry(result)
    await retry(result)

    expectIncomplete(result.current.card)
    expect(result.current.card.balanceRefreshFailed).toBe(true)
    expect(result.current.card.balanceErrorText).toBe('balance_refresh_error')
  })

  it('shows the load error, not the note, when the first read fails', async () => {
    const { result } = renderWithExplorer({
      getAddressBalanceV2: vi
        .fn()
        .mockRejectedValueOnce(new Error('explorer unreachable'))
        .mockResolvedValue(incompleteRead),
    })

    await retry(result)
    expect(result.current.card.balanceLoadFailed).toBe(true)
    expect(result.current.card.balanceErrorText).toBe('balance_load_error')
    expect(result.current.card.utxoReadIncomplete).toBe(false)

    // Try again, and the background has read the statistics this time.
    await retry(result)
    expectIncomplete(result.current.card)
    expect(result.current.card.balanceErrorText).toBeUndefined()
  })

  it('shows only the total beside the note, even for an answer that carries a split', () => {
    // The note says only the total is shown; a split beside it would contradict it.
    const result = renderBalanceCard({ ...fullRead, utxoReadIncomplete: true })

    expect(result.current.utxoReadIncomplete).toBe(true)
    expect(result.current.balanceValue).toBe('0.91000000')
    expect(result.current.availableAmount).toBe('--')
    expect(result.current.unavailableAmount).toBe('--')
  })

  it("does not show another network's note", () => {
    const result = renderBalanceCard({ ...incompleteRead, chainType: ChainType.QBIT_TESTNET4 })

    expect(result.current.balanceLoading).toBe(true)
    expect(result.current.utxoReadIncomplete).toBe(false)
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

    expect(result.current.balanceLoading).toBe(false)
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
      getAddressBalanceV2: vi
        .fn()
        .mockResolvedValueOnce({ ...overLimitSplit, chainType: ChainType.QBIT_MAINNET })
        .mockResolvedValue({ ...overLimitUnknown, chainType: ChainType.QBIT_MAINNET }),
    })
    // No split while the first read is still loading.
    expect(result.current.card.balanceLoading).toBe(true)
    expect(result.current.card.availableAmount).toBe('--')
    expect(result.current.card.unavailableAmount).toBe('--')

    await retry(result)
    expect(result.current.card.balanceLoading).toBe(false)
    expect(result.current.card.availableAmount).toBe('0.60000000')

    await retry(result)
    expect(result.current.card.availableAmount).toBe('--')
    expect(result.current.card.unavailableAmount).toBe('--')
    expect(result.current.card.balanceSplitUnknown).toBe(true)
  })

  it("does not show another network's split", () => {
    const result = renderBalanceCard({ ...overLimitSplit, chainType: ChainType.QBIT_TESTNET4 })

    // Still loading: no balance for this network has landed.
    expect(result.current.balanceLoading).toBe(true)
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

    expect(result.current.balanceLoading).toBe(false)
    expect(result.current.balanceValue).toBe('0.91000000')
    expect(result.current.availableAmount).toBe('--')
    expect(result.current.unavailableAmount).toBe('--')
  })
})

function renderUnloadedBalanceCard() {
  const harness = createHookTestHarness()
  harness.store.dispatch(
    accountActions.setCurrent({ address, pubkey: '11'.repeat(32), type: 'Qbit HD Key Tree' } as any)
  )
  const { result } = renderHook(() => useBalanceCardLogic(), { wrapper: harness.wrapper })
  return { result, store: harness.store }
}

describe('useBalanceCardLogic loading state', () => {
  it('shows loading rather than a zero balance until the first fetch lands', () => {
    const { result, store } = renderUnloadedBalanceCard()

    expect(result.current.balanceLoading).toBe(true)
    expect(result.current.balanceValue).toBe('--')

    const expanded = result.current.isDetailExpanded
    act(() => {
      result.current.handleExpandToggle()
    })
    expect(result.current.isDetailExpanded).toBe(expanded)

    act(() => {
      store.dispatch(accountActions.setBalanceV2({ address, balance }))
    })

    expect(result.current.balanceLoading).toBe(false)
    expect(result.current.balanceValue).toBe('0.00005000')
  })

  it('shows loading while the only balance is from another chain', () => {
    const { result, store } = renderUnloadedBalanceCard()

    act(() => {
      store.dispatch(
        accountActions.setBalanceV2({
          address,
          balance: { ...balance, chainType: ChainType.QBIT_REGTEST },
        })
      )
    })

    expect(result.current.balanceLoading).toBe(true)
    expect(result.current.balanceValue).toBe('--')
  })

  it("shows a newly selected account as loading, never the previous account's balance", () => {
    const { result, store } = renderUnloadedBalanceCard()
    act(() => {
      store.dispatch(accountActions.setBalanceV2({ address, balance }))
    })
    expect(result.current.balanceValue).toBe('0.00005000')

    act(() => {
      store.dispatch(
        accountActions.setCurrent({
          address: 'qbit-another-account',
          pubkey: '22'.repeat(32),
          type: 'Qbit HD Key Tree',
        } as any)
      )
    })

    expect(result.current.balanceLoading).toBe(true)
    expect(result.current.isCurrentChainBalance).toBe(false)
    expect(result.current.balanceValue).toBe('--')
    expect(result.current.availableAmount).toBe('--')
    expect(result.current.unavailableAmount).toBe('--')

    act(() => {
      store.dispatch(
        accountActions.setBalanceV2({
          address: 'qbit-another-account',
          balance: { ...balance, availableBalance: 7_000, totalBalance: 7_000 },
        })
      )
    })

    expect(result.current.balanceLoading).toBe(false)
    expect(result.current.balanceValue).toBe('0.00007000')
  })

  it('stops loading when the first fetch fails', () => {
    const { result, store } = renderUnloadedBalanceCard()

    act(() => {
      store.dispatch(accountActions.setBalanceError({ address, requestId: 1 }))
    })

    expect(result.current.balanceLoading).toBe(false)
    expect(result.current.balanceLoadFailed).toBe(true)
    expect(result.current.balanceValue).toBe('--')
  })
})

describe('useFetchBalanceCallback', () => {
  it('keeps a newly selected account loading when the previous account fails', async () => {
    let rejectBalance: (error: Error) => void = () => undefined
    const wallet = {
      ...createWalletMock(),
      getAddressBalanceV2: vi.fn(
        () =>
          new Promise((_, reject) => {
            rejectBalance = reject
          })
      ),
    }
    const { store, wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => ({ fetchBalance: useFetchBalanceCallback(), card: useBalanceCardLogic() }),
      { wrapper }
    )
    const fetching = result.current.fetchBalance()

    act(() => {
      store.dispatch(
        accountActions.setCurrent({ address: 'qb1zotheraccount', key: 'account-2' } as any)
      )
    })
    await act(async () => {
      rejectBalance(new Error('explorer unavailable'))
      await expect(fetching).rejects.toThrow('explorer unavailable')
    })

    expect(wallet.getAddressBalanceV2).toHaveBeenCalledWith('qb1ztestaccount')
    expect(store.getState().accounts.balanceStatusMap).toEqual({
      qb1ztestaccount: { requestId: expect.any(Number), error: true },
    })
    expect(result.current.card.balanceLoading).toBe(true)
    expect(result.current.card.balanceLoadFailed).toBe(false)
  })
})

describe('useBalanceCardLogic on returning to the home screen', () => {
  it('reads the balance again at once when it mounts showing one read earlier (#188)', async () => {
    // A send plan started on another screen and holds every output now.
    const wallet = Object.assign(createWalletMock(), {
      getAddressBalanceV2: vi.fn().mockResolvedValue({
        availableBalance: 0,
        unavailableBalance: 214_000_000,
        totalBalance: 214_000_000,
        immatureBalance: 0,
        pendingBalance: 0,
        chainType: ChainType.QBIT_MAINNET,
      }),
    })
    const harness = createHookTestHarness({ wallet })
    harness.store.dispatch(
      accountActions['setCurrent']!({
        address,
        pubkey: '11'.repeat(32),
        type: 'Qbit HD Key Tree',
      } as any)
    )
    // The balance read before the plan started.
    harness.store.dispatch(
      accountActions['setBalanceV2']!({
        address,
        balance: {
          availableBalance: 214_000_000,
          unavailableBalance: 0,
          totalBalance: 214_000_000,
          chainType: ChainType.QBIT_MAINNET,
        } as any,
      })
    )
    const { result } = renderHook(() => useBalanceCardLogic(), { wrapper: harness.wrapper })
    expect(result.current.availableAmount).toBe('2.14000000')

    await waitFor(() => expect(result.current.availableAmount).toBe('0.00000000'))
    expect(result.current.unavailableAmount).toBe('2.14000000')
    expect(wallet.getAddressBalanceV2).toHaveBeenCalledTimes(1)
  })
})

/** What an answering background (`recordedReads`) answers to leave a read open. */
const HOLD = Symbol('hold')

/**
 * A background that records each balance read (address, and when, in
 * milliseconds since the card mounted) and leaves it open until the test
 * answers it. Plain functions rather than vi.fn spies: a spy marks every
 * promise it returns as handled, which would hide a rejection the card left
 * unhandled.
 */
function recordedReads(answer?: (index: number) => unknown) {
  const startedAt = Date.now()
  const reads: Array<{
    address: string
    at: number
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }> = []
  let open = 0
  let peakOpen = 0
  const getAddressBalanceV2 = (readAddress: string): Promise<unknown> => {
    const reading = new Promise((resolve, reject) => {
      open += 1
      peakOpen = Math.max(peakOpen, open)
      let settled = false
      const settle = (): boolean => {
        if (settled) return false
        settled = true
        open -= 1
        return true
      }
      reads.push({
        address: readAddress,
        at: Date.now() - startedAt,
        resolve: value => settle() && resolve(value),
        reject: error => settle() && reject(error),
      })
    })
    // An answering background settles each read as it starts, but those it holds.
    if (answer) {
      const read = reads[reads.length - 1]
      const value = answer(reads.length - 1)
      if (value === HOLD) return reading
      if (value instanceof Error) read.reject(value)
      else read.resolve(value)
    }
    return reading
  }
  return {
    getAddressBalanceV2,
    reads,
    times: () => reads.map(read => read.at),
    peakOpen: () => peakOpen,
  }
}

function renderPolledCard(
  getAddressBalanceV2: (readAddress: string) => Promise<unknown>,
  { loaded = false }: { loaded?: boolean } = {}
) {
  const wallet = { ...createWalletMock(), getAddressBalanceV2 }
  const harness = createHookTestHarness({ wallet: wallet as any })
  harness.store.dispatch(
    accountActions.setCurrent({ address, pubkey: '11'.repeat(32), type: 'Qbit HD Key Tree' } as any)
  )
  if (loaded) {
    harness.store.dispatch(accountActions.setBalanceV2({ address, balance }))
  }
  const view = renderHook(
    () => ({ card: useBalanceCardLogic(), fetchBalance: useFetchBalanceCallback() }),
    { wrapper: harness.wrapper }
  )
  const selectAccount = (next: string): void => {
    act(() => {
      harness.store.dispatch(
        accountActions.setCurrent({ address: next, pubkey: '22'.repeat(32), type: 'Qbit HD Key Tree' } as any)
      )
    })
  }
  return { ...harness, ...view, selectAccount }
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const seconds = (...values: number[]): number[] => values.map(value => value * 1000)

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  })
}

async function showOrHideDocument(hidden: boolean): Promise<void> {
  setDocumentHidden(hidden)
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

describe('useBalanceCardLogic polling', () => {
  afterEach(() => {
    vi.useRealTimers()
    delete (document as { hidden?: boolean }).hidden
    delete (document as { visibilityState?: string }).visibilityState
  })

  type Polled = ReturnType<typeof renderPolledCard>
  it.each<[string, { loaded?: boolean }, (card: Polled) => void, number]>([
    ['the poll', {}, () => undefined, 10_000],
    ['the read on mounting', { loaded: true }, () => undefined, 0],
    ['the refresh button', {}, ({ result }) => result.current.card.refreshBalance(), 1_000],
    ['Try again', {}, ({ result }) => result.current.card.retryBalance(), 0],
  ])(
    'skips poll ticks while %s is still reading, and runs one of them 2 s after it lands',
    async (_source, options, start, firstAt) => {
      vi.useFakeTimers()
      const background = recordedReads()
      const polled = renderPolledCard(background.getAddressBalanceV2, options)
      act(() => start(polled))

      await advance(firstAt)
      expect(background.times()).toEqual([firstAt])
      // Held open across three poll intervals: no tick reads beside it.
      await advance(35_000)
      expect(background.times()).toEqual([firstAt])
      expect(background.peakOpen()).toBe(1)

      await act(async () => {
        background.reads[0].resolve(balance)
      })
      // One of the ticks that fell due runs a short pause after it lands.
      await advance(1_999)
      expect(background.times()).toEqual([firstAt])
      await advance(1)
      expect(background.times()).toEqual([firstAt, firstAt + 37_000])
      await act(async () => {
        background.reads[1].resolve(balance)
      })
      // Then the cadence goes on from that read.
      await advance(9_999)
      expect(background.reads).toHaveLength(2)
      await advance(1)
      expect(background.times()).toEqual([firstAt, firstAt + 37_000, firstAt + 47_000])
      expect(background.peakOpen()).toBe(1)
    }
  )

  it('reads once more 2 s after a read held open across several intervals lands, however many ticks fell due', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    renderPolledCard(background.getAddressBalanceV2)

    await advance(10_000)
    // Four more ticks fall due while the first poll's read is open, which is
    // not yet old enough to be given up on.
    await advance(45_000)
    expect(background.times()).toEqual(seconds(10))
    expect(background.peakOpen()).toBe(1)

    await act(async () => {
      background.reads[0].resolve(incompleteRead)
    })
    await advance(1_999)
    expect(background.times()).toEqual(seconds(10))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 57))
    await act(async () => {
      background.reads[1].resolve(fullRead)
    })

    // Exactly one: the next read is an interval after it started.
    await advance(9_999)
    expect(background.times()).toEqual(seconds(10, 57))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 57, 67))
    expect(background.peakOpen()).toBe(1)
  })

  it('runs a remembered tick only once every read of the card has landed, 2 s after the last', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const { result } = renderPolledCard(background.getAddressBalanceV2)

    // The poll's read from 10 s misses the tick at 20 s; the refresh button
    // reads from 23 s beside it.
    await advance(22_000)
    act(() => result.current.card.refreshBalance())
    await advance(1_000)
    expect(background.times()).toEqual(seconds(10, 23))

    await advance(7_000)
    await act(async () => {
      background.reads[0].resolve(balance)
    })
    // The refresh button's read is still open: no tick beside it.
    await advance(20_000)
    expect(background.times()).toEqual(seconds(10, 23))

    await act(async () => {
      background.reads[1].resolve(balance)
    })
    await advance(1_999)
    expect(background.times()).toEqual(seconds(10, 23))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 23, 52))
  })

  it('follows long reads closely: 20 s incomplete, 20 s incomplete and 4 s full start at 0, 22 and 44 s, then every 10 s', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const { result } = renderPolledCard(background.getAddressBalanceV2, { loaded: true })
    // The read on mounting, at 0. Each of the first two reads works through the
    // account's outputs for the background's 20 s and stops there.
    expect(background.times()).toEqual([0])

    await advance(20_000)
    await act(async () => {
      background.reads[0].resolve(incompleteRead)
    })
    expect(result.current.card.utxoReadIncomplete).toBe(true)
    await advance(2_000)
    expect(background.times()).toEqual(seconds(0, 22))

    await advance(20_000)
    await act(async () => {
      background.reads[1].resolve(incompleteRead)
    })
    await advance(2_000)
    expect(background.times()).toEqual(seconds(0, 22, 44))

    await advance(4_000)
    await act(async () => {
      background.reads[2].resolve(fullRead)
    })
    expect(result.current.card.utxoReadIncomplete).toBe(false)
    expect(result.current.card.availableAmount).toBe('0.60000000')

    // No tick fell due during the short read: the next is 10 s after it started.
    await advance(5_999)
    expect(background.times()).toEqual(seconds(0, 22, 44))
    await advance(1)
    expect(background.times()).toEqual(seconds(0, 22, 44, 54))
    await act(async () => {
      background.reads[3].resolve(fullRead)
    })
    await advance(10_000)
    expect(background.times()).toEqual(seconds(0, 22, 44, 54, 64))
    expect(background.peakOpen()).toBe(1)
  })

  /**
   * Two failed reads at 10 and 20 s, then a third from 40 s that runs past its
   * tick (60 s) and fails 25 s in: the third failure in a row.
   */
  async function failThirdReadLate(polled: Polled, background: ReturnType<typeof recordedReads>) {
    const fail = async (index: number): Promise<void> => {
      await act(async () => {
        background.reads[index].reject(new Error('explorer unreachable'))
      })
    }
    await advance(10_000)
    await fail(0)
    await advance(10_000)
    await fail(1)
    await advance(20_000)
    expect(background.times()).toEqual(seconds(10, 20, 40))
    await advance(25_000)
    await fail(2)
    expect(polled.result.current.card.balanceLoadFailed).toBe(true)
  }

  it('waits for the back-off after a long failed read: after the third failure in a row, the next read is 40 s after it ended', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const polled = renderPolledCard(background.getAddressBalanceV2)
    await failThirdReadLate(polled, background)

    // Neither 2 s after it failed (67 s) nor 40 s after it started (80 s):
    // 40 s after it failed.
    await advance(39_999)
    expect(background.times()).toEqual(seconds(10, 20, 40))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 20, 40, 105))
  })

  it.each<[string, number, number, number, number[]]>([
    // The poll's read from 10 s never answers, hidden from 15 s: stuck at
    // 70 s, so its 10 s back-off is over at 80 s.
    ['shown again long after that', 0, 15, 300, seconds(10, 300)],
    ['shown again before that back-off is over', 0, 15, 75, seconds(10, 80)],
    // After three failures (a 40 s back-off) the read from 80 s never
    // answers, hidden from 85 s: stuck at 140 s, its back-off 80 s.
    ['shown again long after that, past a 40 s back-off', 3, 85, 600, seconds(80, 600)],
  ])(
    'counts the back-off of a read stuck while the page was hidden from when it got stuck: %s',
    async (_case, failures, hiddenAt, shownAt, reads) => {
      vi.useFakeTimers()
      const startedAt = Date.now()
      const advanceTo = (at: number): Promise<void> => advance(at - (Date.now() - startedAt))
      const background = recordedReads()
      renderPolledCard(background.getAddressBalanceV2)
      for (const [index, at] of seconds(10, 20, 40).slice(0, failures).entries()) {
        await advanceTo(at)
        await act(async () => {
          background.reads[index].reject(new Error('explorer unreachable'))
        })
      }

      await advanceTo(hiddenAt * 1000)
      await showOrHideDocument(true)
      await advanceTo(shownAt * 1000)
      await showOrHideDocument(false)
      // Due at once, or once the back-off from when it got stuck is over;
      // not a back-off counted from the moment the page was shown.
      await advanceTo(reads[1])
      expect(background.times().slice(failures)).toEqual(reads)
    }
  )

  it('counts each of several reads stuck while hidden as one failure, and the back-off from the latest', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const { result } = renderPolledCard(background.getAddressBalanceV2)

    // The poll's read from 10 s and Try again's from 30 s never answer: stuck
    // at 70 and 90 s while the page is hidden from 35 s.
    await advance(30_000)
    act(() => result.current.card.retryBalance())
    await advance(5_000)
    await showOrHideDocument(true)
    await advance(70_000)
    // Shown at 105 s: two failures, a 20 s back-off counted from 90 s.
    await showOrHideDocument(false)
    await advance(4_999)
    expect(background.times()).toEqual(seconds(10, 30))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 30, 110))
  })

  it('releases Try again when the poll gives up on its read, and a second tap reads', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const { result } = renderPolledCard(background.getAddressBalanceV2)

    // Try again at 5 s, and its answer is lost.
    await advance(5_000)
    act(() => result.current.card.retryBalance())
    await advance(59_999)
    expect(result.current.card.isRetryingBalance).toBe(true)
    act(() => result.current.card.retryBalance())
    expect(background.times()).toEqual(seconds(5))

    // Given up on 60 s after it started: the button is free again.
    await advance(1)
    expect(result.current.card.isRetryingBalance).toBe(false)
    act(() => result.current.card.retryBalance())
    expect(background.times()).toEqual(seconds(5, 65))
    expect(result.current.card.isRetryingBalance).toBe(true)

    // The lost answer turning up late frees nothing and moves nothing: the
    // second tap's read is still waited for, and once it answers the next
    // poll is 10 s after it started.
    await advance(1_000)
    await act(async () => {
      background.reads[0].resolve(balance)
    })
    expect(result.current.card.isRetryingBalance).toBe(true)
    await act(async () => {
      background.reads[1].resolve(balance)
    })
    expect(result.current.card.isRetryingBalance).toBe(false)
    await advance(8_999)
    expect(background.times()).toEqual(seconds(5, 65))
    await advance(1)
    expect(background.times()).toEqual(seconds(5, 65, 75))
  })

  it('waits out the back-off from a failed read when the page is shown again', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const polled = renderPolledCard(background.getAddressBalanceV2)
    await failThirdReadLate(polled, background)

    // Hidden after the failure at 65 s, shown again at 80 s: 40 s after the
    // last read started, but the back-off runs until 105 s.
    await showOrHideDocument(true)
    await advance(15_000)
    await showOrHideDocument(false)
    expect(background.times()).toEqual(seconds(10, 20, 40))
    await advance(24_999)
    expect(background.times()).toEqual(seconds(10, 20, 40))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 20, 40, 105))
  })

  it('lets a read that starts after a tick fell due answer it: the next poll is one interval after that read started', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const { result } = renderPolledCard(background.getAddressBalanceV2)

    // The poll's read from 10 s misses the tick at 20 s; Try again reads at
    // 22 s. The first answers at 25 s, Try again's 9 s after it started.
    await advance(22_000)
    act(() => result.current.card.retryBalance())
    await advance(3_000)
    await act(async () => {
      background.reads[0].resolve(balance)
    })
    await advance(6_000)
    await act(async () => {
      background.reads[1].resolve(balance)
    })

    // At 32 s, not 2 s after the last answer (33 s): Try again's read
    // answered the tick that fell due before it.
    await advance(999)
    expect(background.times()).toEqual(seconds(10, 22))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 22, 32))
  })

  it('catches up 2 s after a read that answers last, though another read failed meanwhile', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const { result } = renderPolledCard(background.getAddressBalanceV2)

    // The poll's read from 10 s and Try again's from 15 s are both open when
    // the tick at 25 s falls due. Try again's fails at 28 s, and the poll's
    // answers at 30 s: the last word is a success, which ends the back-off.
    await advance(15_000)
    act(() => result.current.card.retryBalance())
    await advance(13_000)
    await act(async () => {
      background.reads[1].reject(new Error('explorer unreachable'))
    })
    await advance(2_000)
    await act(async () => {
      background.reads[0].resolve(balance)
    })

    // The tick missed meanwhile runs 2 s after that answer, at 32 s, not 10 s
    // after the failure (38 s).
    await advance(1_999)
    expect(background.times()).toEqual(seconds(10, 15))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 15, 32))
  })

  it('lets Try again read at once while a tick waits for the back-off', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const polled = renderPolledCard(background.getAddressBalanceV2)
    await failThirdReadLate(polled, background)

    await advance(5_000)
    act(() => polled.result.current.card.retryBalance())
    expect(background.times()).toEqual(seconds(10, 20, 40, 70))
    await act(async () => {
      background.reads[3].resolve(balance)
    })
    expect(polled.result.current.card.isRetryingBalance).toBe(false)
    expect(polled.result.current.card.balanceLoadFailed).toBe(false)

    // Its success ends the back-off: one poll 10 s after it, not another at 80 s.
    await advance(9_999)
    expect(background.times()).toEqual(seconds(10, 20, 40, 70))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 20, 40, 70, 80))
  })

  it.each([
    ['a full answer', fullRead],
    ['an answer that ran out of time part of the way through', incompleteRead],
  ])(
    'backs off after answers whose read of the outputs failed, as after a rejection, until %s',
    async (_reset, resetAnswer) => {
      vi.useFakeTimers()
      let answer: unknown = failedRead
      const background = recordedReads(() => answer)
      const { result } = renderPolledCard(background.getAddressBalanceV2)

      await advance(400_000)
      expect(background.times()).toEqual(seconds(10, 20, 40, 80, 160, 280, 400))
      // Shown as any incomplete answer is: the total, the note and `--`, no error.
      expect(result.current.card.utxoReadIncomplete).toBe(true)
      expect(result.current.card.balanceValue).toBe('0.91000000')
      expect(result.current.card.availableAmount).toBe('--')
      expect(result.current.card.balanceErrorText).toBeUndefined()

      answer = resetAnswer
      await advance(120_000)
      await advance(20_000)
      expect(background.times().slice(7)).toEqual(seconds(520, 530, 540))
    }
  )

  it.each<[string, (read: ReturnType<typeof recordedReads>['reads'][number]) => void]>([
    ['rejects', read => read.reject(new Error('the statistics read timed out'))],
    ['answers that its read of the outputs failed', read => read.resolve(failedRead)],
  ])(
    "waits 10, 20 and 40 s from each one's end after three slow reads in a row that each %s 20 s in",
    async (_how, fail) => {
      vi.useFakeTimers()
      const background = recordedReads()
      renderPolledCard(background.getAddressBalanceV2)
      const failAt = async (index: number): Promise<void> => {
        await advance(20_000)
        await act(async () => {
          fail(background.reads[index])
        })
      }

      await advance(10_000)
      await failAt(0)
      await advance(9_999)
      expect(background.times()).toEqual(seconds(10))
      await advance(1)
      expect(background.times()).toEqual(seconds(10, 40))

      await failAt(1)
      await advance(19_999)
      expect(background.times()).toEqual(seconds(10, 40))
      await advance(1)
      expect(background.times()).toEqual(seconds(10, 40, 80))

      await failAt(2)
      await advance(39_999)
      expect(background.times()).toEqual(seconds(10, 40, 80))
      await advance(1)
      expect(background.times()).toEqual(seconds(10, 40, 80, 140))
    }
  )

  it('backs off from each read it gives up on: with no answer ever, reads at 0, 70, 150, 250, 390, 570 and 750 s', async () => {
    vi.useFakeTimers()
    // The read on mounting at 0 and every read after it: none ever answers.
    const background = recordedReads()
    renderPolledCard(background.getAddressBalanceV2, { loaded: true })

    // Each is given up on 60 s after it started, then the back-off: 10, 20,
    // 40, 80 s. Without it, a read every 60 s: 0, 60, 120, 180, 240 …
    await advance(389_999)
    expect(background.times()).toEqual(seconds(0, 70, 150, 250))
    await advance(1)
    expect(background.times()).toEqual(seconds(0, 70, 150, 250, 390))
    // Still given up on 60 s after it started once the back-off is longer
    // than that, then at most 2 minutes before the next.
    await advance(360_000)
    expect(background.times()).toEqual(seconds(0, 70, 150, 250, 390, 570, 750))
  })

  it('polls one interval after the last read started when a read answers just before it would be given up on', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const { result } = renderPolledCard(background.getAddressBalanceV2)

    // The first poll's read from 10 s is still open when Try again reads at
    // 62 s, which answers at once; the first answers at 65 s, 5 s before it
    // would have been given up on.
    await advance(62_000)
    act(() => result.current.card.retryBalance())
    await advance(1_000)
    await act(async () => {
      background.reads[1].resolve(balance)
    })
    await advance(2_000)
    await act(async () => {
      background.reads[0].resolve(balance)
    })

    // Not at 70 s, when it would have been given up on: 10 s after Try again.
    await advance(6_999)
    expect(background.times()).toEqual(seconds(10, 62))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 62, 72))
  })

  it.each<[string, number, number | undefined, number, number]>([
    ['40 s, longer than the time left on it', 3, undefined, 140, 220],
    ['80 s, longer than the whole wait', 4, undefined, 220, 340],
    ['40 s, when Try again started it off the tick grid', 3, 45, 105, 185],
  ])(
    'gives up on a read 60 s after it started during a back-off of %s',
    async (_case, failures, tryAgainAt, givenUpAt, nextAt) => {
      vi.useFakeTimers()
      const startedAt = Date.now()
      const advanceTo = (at: number): Promise<void> => advance(at - (Date.now() - startedAt))
      const background = recordedReads()
      const polled = renderPolledCard(background.getAddressBalanceV2)
      // Quick failures at 10, 20, 40 (and 80) s: a back-off of 40 (or 80) s.
      for (const [index, at] of seconds(10, 20, 40, 80).slice(0, failures).entries()) {
        await advanceTo(at)
        await act(async () => {
          background.reads[index].reject(new Error('explorer unreachable'))
        })
      }
      if (tryAgainAt !== undefined) {
        await advanceTo(tryAgainAt * 1000)
        act(() => polled.result.current.card.retryBalance())
      }

      // The next read, the poll's or Try again's, never answers: given up on
      // 60 s after it started, and the next read comes the back-off after that.
      await advanceTo(nextAt * 1000 - 1)
      expect(background.times().slice(failures)).toEqual(seconds(givenUpAt - 60))
      await advance(1)
      expect(background.times().slice(failures)).toEqual(seconds(givenUpAt - 60, nextAt))
    }
  )

  it.each<[string, (read: ReturnType<typeof recordedReads>['reads'][number]) => void]>([
    ['answers', read => read.resolve(fullRead)],
    ['fails', read => read.reject(new Error('the answer was lost'))],
  ])(
    'gives up on a read held open for minutes once it is 60 s old, as on a failed read, and is unaffected when that read finally %s',
    async (_how, settle) => {
      vi.useFakeTimers()
      // The first poll's read never answers; every read after it does at once.
      let later: unknown = fullRead
      const background = recordedReads(index => (index === 0 ? HOLD : later))
      const { result, unmount } = renderPolledCard(background.getAddressBalanceV2)

      // Given up on at 70 s, as a failed read: the next read 10 s later,
      // and every 10 s again once that one answers.
      await advance(79_999)
      expect(background.times()).toEqual(seconds(10))
      await advance(1)
      expect(background.times()).toEqual(seconds(10, 80))
      await advance(230_000)
      const everyTenSeconds = Array.from({ length: 24 }, (_, index) => 80 + index * 10)
      expect(background.times()).toEqual(seconds(10, ...everyTenSeconds))
      // The stuck read and, at a time, one beside it.
      expect(background.peakOpen()).toBe(2)
      expect(result.current.card.availableAmount).toBe('0.60000000')

      // Then the reads beside it fail to read the outputs: 10, 20 s between them.
      later = failedRead
      await advance(50_000)
      expect(background.times().slice(-3)).toEqual(seconds(320, 330, 350))

      // Nearly six minutes after it started, between two ticks, it settles:
      // neither its answer nor its failure replaces the newer balance, moves
      // the next read (40 s after the last failure, at 390 s) or counts in
      // the back-off.
      await act(async () => {
        settle(background.reads[0])
      })
      expect(result.current.card.availableAmount).toBe('--')
      expect(result.current.card.balanceErrorText).toBeUndefined()
      await advance(29_999)
      expect(background.times().slice(-1)).toEqual(seconds(350))
      await advance(1)
      expect(background.times().slice(-1)).toEqual(seconds(390))
      await advance(80_000)
      expect(background.times().slice(-2)).toEqual(seconds(390, 470))

      unmount()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  type State = [
    string,
    (background: ReturnType<typeof recordedReads>) => Promise<void>,
    (index: number) => unknown,
  ]
  const states: State[] = [
    [
      'backing off after answers whose read of the outputs failed',
      async background => {
        await advance(50_000)
        expect(background.times()).toEqual(seconds(10, 20, 40))
      },
      () => failedRead,
    ],
    [
      'waiting out the back-off after a slow failure',
      async background => {
        await advance(30_000)
        await act(async () => {
          background.reads[0].reject(new Error('the statistics read timed out'))
        })
        await advance(5_000)
        expect(background.times()).toEqual(seconds(10))
      },
      () => HOLD,
    ],
    [
      'beside a read held open, before the poll gives up on it',
      async background => {
        await advance(30_000)
        expect(background.times()).toEqual(seconds(10))
      },
      () => HOLD,
    ],
    [
      'beside a read the poll gave up on',
      async background => {
        await advance(75_000)
        expect(background.times()).toEqual(seconds(10))
      },
      () => HOLD,
    ],
    [
      'during the pause before a catch-up',
      async background => {
        await advance(35_000)
        await act(async () => {
          background.reads[0].resolve(incompleteRead)
        })
        await advance(500)
        expect(background.times()).toEqual(seconds(10))
      },
      () => HOLD,
    ],
  ]
  // Try again reads at once; the refresh button after its debounce, as ever.
  const presses = [
    ['Try again', ({ result }: Polled) => result.current.card.retryBalance(), 0],
    ['the refresh button', ({ result }: Polled) => result.current.card.refreshBalance(), 1_000],
  ] as const
  it.each(
    states.flatMap(([state, setup, answer]) =>
      presses.map(([button, press, delay]) => [button, state, setup, answer, press, delay] as const)
    )
  )('%s still reads at once %s', async (_button, _state, setup, answer, press, delay) => {
    vi.useFakeTimers()
    const startedAt = Date.now()
    const background = recordedReads(answer)
    const polled = renderPolledCard(background.getAddressBalanceV2)
    await setup(background)
    const before = background.reads.length
    const pressedAt = Date.now() - startedAt

    act(() => press(polled))
    await advance(delay)

    expect(background.times().slice(before)).toEqual([pressedAt + delay])
  })

  it('does not catch up while the page is hidden, and reads when it is shown again', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    renderPolledCard(background.getAddressBalanceV2)

    // The poll's read from 10 s is still open when its next tick falls due.
    await advance(25_000)
    await showOrHideDocument(true)
    await advance(5_000)
    await act(async () => {
      background.reads[0].resolve(balance)
    })
    await advance(60_000)
    expect(background.times()).toEqual(seconds(10))

    await showOrHideDocument(false)
    expect(background.times()).toEqual(seconds(10, 90))
    await act(async () => {
      background.reads[1].resolve(balance)
    })
    await advance(10_000)
    expect(background.times()).toEqual(seconds(10, 90, 100))
  })

  it('leaves no timer and makes no read when the card unmounts during the pause before a catch-up', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const { unmount } = renderPolledCard(background.getAddressBalanceV2)

    await advance(25_000)
    await act(async () => {
      background.reads[0].resolve(balance)
    })
    // The catch-up waits until 27 s.
    await advance(1_000)
    expect(vi.getTimerCount()).toBe(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
    await advance(60_000)
    expect(background.times()).toEqual(seconds(10))
  })

  it('makes no catch-up read for the old account when another is selected during the pause', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const { selectAccount } = renderPolledCard(background.getAddressBalanceV2)

    await advance(25_000)
    await act(async () => {
      background.reads[0].resolve(balance)
    })
    await advance(1_000)
    selectAccount('qbit-another-account')
    // Only the new account's cadence is waiting: nothing at 27 s.
    expect(vi.getTimerCount()).toBe(1)

    await advance(9_999)
    expect(background.reads.map(read => read.address)).toEqual([address])
    await advance(1)
    expect(background.reads.map(read => read.address)).toEqual([address, 'qbit-another-account'])
    expect(background.times()).toEqual(seconds(10, 36))
  })

  it('makes one background call per tick: the balance read, not the address summary', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const background = recordedReads(() => balance)
    const wallet = new Proxy(
      { ...createWalletMock(), getAddressBalanceV2: background.getAddressBalanceV2 },
      {
        get(target, method: string) {
          const member = (target as Record<string, unknown>)[method]
          if (typeof member !== 'function') return member
          return (...args: unknown[]) => {
            calls.push(method)
            return member(...args)
          }
        },
      }
    )
    const harness = createHookTestHarness({ wallet: wallet as any })
    harness.store.dispatch(
      accountActions.setCurrent({ address, pubkey: '11'.repeat(32), type: 'Qbit HD Key Tree' } as any)
    )
    renderHook(() => useBalanceCardLogic(), { wrapper: harness.wrapper })

    await advance(10_000)
    expect(calls).toEqual(['getAddressBalanceV2'])
    await advance(20_000)
    expect(calls).toEqual(['getAddressBalanceV2', 'getAddressBalanceV2', 'getAddressBalanceV2'])
  })

  it('backs off after failed reads, 10, 20, 40 s and on up to 2 minutes, and back to 10 s after a success', async () => {
    vi.useFakeTimers()
    let answer: unknown = new Error('explorer unreachable')
    const background = recordedReads(() => answer)

    const unhandled = await unhandledRejectionsDuring(async () => {
      const { result } = renderPolledCard(background.getAddressBalanceV2)

      await advance(400_000)
      expect(background.times()).toEqual(seconds(10, 20, 40, 80, 160, 280, 400))
      expect(result.current.card.balanceLoadFailed).toBe(true)

      await advance(119_999)
      expect(background.reads).toHaveLength(7)
      answer = balance
      await advance(1)
      expect(background.times().slice(7)).toEqual(seconds(520))
      expect(result.current.card.balanceLoadFailed).toBe(false)

      await advance(20_000)
      expect(background.times().slice(7)).toEqual(seconds(520, 530, 540))
    })
    // Every failed read was handled, by the card's poll or its status.
    expect(unhandled).toEqual([])
  })

  it('keeps the normal cadence while the answers are incomplete, after a back-off too', async () => {
    vi.useFakeTimers()
    let answer: unknown = new Error('explorer unreachable')
    const background = recordedReads(() => answer)
    const { result } = renderPolledCard(background.getAddressBalanceV2)

    await advance(40_000)
    expect(background.times()).toEqual(seconds(10, 20, 40))

    // The background read the statistics, and makes progress through the
    // outputs with every read: that is no failure to back off from.
    answer = incompleteRead
    await advance(40_000)
    expect(background.times()).toEqual(seconds(10, 20, 40, 80))
    expect(result.current.card.utxoReadIncomplete).toBe(true)
    await advance(30_000)
    expect(background.times()).toEqual(seconds(10, 20, 40, 80, 90, 100, 110))

    answer = fullRead
    await advance(20_000)
    expect(background.times()).toEqual(seconds(10, 20, 40, 80, 90, 100, 110, 120, 130))
    expect(result.current.card.utxoReadIncomplete).toBe(false)
    expect(result.current.card.availableAmount).toBe('0.60000000')
  })

  it.each<[string, (card: Polled) => void, number]>([
    ['Try again reads at once', ({ result }) => result.current.card.retryBalance(), 0],
    ['the refresh button reads', ({ result }) => result.current.card.refreshBalance(), 1_000],
  ])(
    '%s during a back-off, and its success brings the poll back to 10 s',
    async (_case, refresh, delay) => {
      vi.useFakeTimers()
      let answer: unknown = new Error('explorer unreachable')
      const background = recordedReads(() => answer)
      const polled = renderPolledCard(background.getAddressBalanceV2)

      // Three failures: the next poll would be 40 s after the last, at 80 s.
      await advance(50_000)
      expect(background.times()).toEqual(seconds(10, 20, 40))

      answer = balance
      act(() => refresh(polled))
      await advance(delay)
      expect(background.times()).toEqual([...seconds(10, 20, 40), 50_000 + delay])
      expect(polled.result.current.card.balanceLoadFailed).toBe(false)

      await advance(10_000)
      expect(background.times()).toEqual([...seconds(10, 20, 40), 50_000 + delay, 60_000 + delay])
    }
  )

  it('reads nothing while the page is hidden, and at once when it is shown again after an interval', async () => {
    vi.useFakeTimers()
    const background = recordedReads(() => balance)
    renderPolledCard(background.getAddressBalanceV2)

    await advance(5_000)
    await showOrHideDocument(true)
    await advance(60_000)
    expect(background.times()).toEqual([])

    await showOrHideDocument(false)
    expect(background.times()).toEqual(seconds(65))
    // Then the cadence resumes from that read.
    await advance(10_000)
    expect(background.times()).toEqual(seconds(65, 75))
  })

  it('waits for the next tick when the page is shown again within an interval of the last read', async () => {
    vi.useFakeTimers()
    const background = recordedReads(() => balance)
    renderPolledCard(background.getAddressBalanceV2)

    await advance(12_000)
    expect(background.times()).toEqual(seconds(10))
    await showOrHideDocument(true)
    await advance(3_000)
    await showOrHideDocument(false)
    expect(background.times()).toEqual(seconds(10))

    await advance(4_999)
    expect(background.times()).toEqual(seconds(10))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 20))
  })

  it('does not read beside a read still in flight when the page is shown again', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    renderPolledCard(background.getAddressBalanceV2)

    await advance(10_000)
    await showOrHideDocument(true)
    await advance(30_000)
    await showOrHideDocument(false)
    expect(background.times()).toEqual(seconds(10))
    expect(background.peakOpen()).toBe(1)

    await act(async () => {
      background.reads[0].resolve(balance)
    })
    // The tick due on showing runs a short pause after the read lands.
    await advance(1_999)
    expect(background.times()).toEqual(seconds(10))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 42))
  })

  it('polls, and leaves no timer behind, where there is no document', async () => {
    vi.useFakeTimers()
    const background = recordedReads(() => balance)
    const harness = createHookTestHarness({
      wallet: { ...createWalletMock(), getAddressBalanceV2: background.getAddressBalanceV2 } as any,
    })
    harness.store.dispatch(
      accountActions.setCurrent({ address, pubkey: '11'.repeat(32), type: 'Qbit HD Key Tree' } as any)
    )
    // Created while there is a document; the card itself never sees one, not
    // even declared, as on a platform without a DOM, where naming it throws.
    const container = document.createElement('div')
    const declared = Object.getOwnPropertyDescriptor(globalThis, 'document')!
    delete (globalThis as { document?: Document }).document
    try {
      expect(() => document).toThrow(ReferenceError)
      // render rather than renderHook, which would mount on document.body.
      let card!: ReturnType<typeof useBalanceCardLogic>
      const Card = (): null => {
        card = useBalanceCardLogic()
        return null
      }
      const { unmount } = render(createElement(harness.wrapper, null, createElement(Card)), {
        container,
        baseElement: container,
      })

      await advance(30_000)
      expect(background.times()).toEqual(seconds(10, 20, 30))
      expect(card.balanceValue).toBe('0.00005000')

      unmount()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      Object.defineProperty(globalThis, 'document', declared)
    }
  })

  it('starts a new account from a clean cadence: no back-off, no read in flight, no tick for the old account', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const { selectAccount, result } = renderPolledCard(background.getAddressBalanceV2)

    // The first account fails twice (the next poll would be 20 s later),
    // and its third read is still in flight.
    await advance(10_000)
    await act(async () => {
      background.reads[0].reject(new Error('explorer unreachable'))
    })
    await advance(10_000)
    await act(async () => {
      background.reads[1].reject(new Error('explorer unreachable'))
    })
    await advance(20_000)
    expect(background.times()).toEqual(seconds(10, 20, 40))

    await advance(2_000)
    selectAccount('qbit-another-account')
    // Ten seconds on, not twenty, and not skipped for the old account's read.
    await advance(9_999)
    expect(background.reads).toHaveLength(3)
    await advance(1)
    expect(background.reads.map(read => read.address)).toEqual([
      address,
      address,
      address,
      'qbit-another-account',
    ])
    expect(background.times()[3]).toBe(52_000)

    // The old account's read failing later does not back the new one off.
    await act(async () => {
      background.reads[2].reject(new Error('explorer unreachable'))
      background.reads[3].resolve({ ...balance, totalBalance: 7_000, availableBalance: 7_000 })
    })
    await advance(10_000)
    expect(background.times().slice(3)).toEqual(seconds(52, 62))
    expect(background.reads.slice(3).map(read => read.address)).toEqual([
      'qbit-another-account',
      'qbit-another-account',
    ])
    expect(result.current.card.balanceValue).toBe('0.00007000')
  })

  it('starts a new network from a clean cadence', async () => {
    vi.useFakeTimers()
    let answer: unknown = new Error('explorer unreachable')
    const background = recordedReads(() => answer)
    const { store } = renderPolledCard(background.getAddressBalanceV2)

    // Four failures: the next poll would be 80 s after the last, at 160 s.
    await advance(80_000)
    expect(background.times()).toEqual(seconds(10, 20, 40, 80))

    answer = { ...balance, chainType: ChainType.QBIT_TESTNET4 }
    await advance(5_000)
    act(() => {
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })
    await advance(10_000)
    expect(background.times()).toEqual(seconds(10, 20, 40, 80, 95))
  })

  it("lets Try again run for a new account while the old account's retry is still out", async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const { result, selectAccount } = renderPolledCard(background.getAddressBalanceV2)

    act(() => result.current.card.retryBalance())
    expect(result.current.card.isRetryingBalance).toBe(true)

    selectAccount('qbit-another-account')
    expect(result.current.card.isRetryingBalance).toBe(false)
    act(() => result.current.card.retryBalance())
    expect(background.reads.map(read => read.address)).toEqual([address, 'qbit-another-account'])
    expect(result.current.card.isRetryingBalance).toBe(true)

    // The old retry ending does not end the new one.
    await act(async () => {
      background.reads[0].reject(new Error('explorer unreachable'))
    })
    expect(result.current.card.isRetryingBalance).toBe(true)
    await act(async () => {
      background.reads[1].resolve(balance)
    })
    expect(result.current.card.isRetryingBalance).toBe(false)
  })

  it('leaves no timer or listener behind when it unmounts', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const added: EventListenerOrEventListenerObject[] = []
    const removed: EventListenerOrEventListenerObject[] = []
    const addEventListener = document.addEventListener.bind(document)
    const removeEventListener = document.removeEventListener.bind(document)
    vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
      if (type === 'visibilitychange' && listener) added.push(listener)
      addEventListener(type, listener, options)
    })
    vi.spyOn(document, 'removeEventListener').mockImplementation((type, listener, options) => {
      if (type === 'visibilitychange' && listener) removed.push(listener)
      removeEventListener(type, listener, options)
    })
    const { result, unmount, selectAccount } = renderPolledCard(background.getAddressBalanceV2, {
      loaded: true,
    })
    selectAccount('qbit-another-account')
    act(() => result.current.card.refreshBalance())
    // A poll timer and the refresh button's debounce are waiting, and the
    // read on mounting is still in flight.
    expect(vi.getTimerCount()).toBe(2)
    expect(added).toHaveLength(2)

    unmount()

    expect(vi.getTimerCount()).toBe(0)
    expect(removed).toEqual(added)
    await act(async () => {
      background.reads[0].resolve(balance)
    })
    await showOrHideDocument(true)
    await showOrHideDocument(false)
    await advance(60_000)
    expect(background.reads).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    vi.restoreAllMocks()
  })

  it('lets a refresh from elsewhere read beside a poll in flight, and keeps the newer answer', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const { result } = renderPolledCard(background.getAddressBalanceV2)

    await advance(10_000)
    // A refresh after a broadcast, say: it neither waits for the poll's read
    // nor takes its answer.
    let refresh!: Promise<void>
    act(() => {
      refresh = result.current.fetchBalance()
    })
    expect(background.times()).toEqual(seconds(10, 10))

    await act(async () => {
      background.reads[1].resolve(fullRead)
      await refresh
    })
    expect(result.current.card.availableAmount).toBe('0.60000000')
    await act(async () => {
      background.reads[0].resolve(incompleteRead)
    })
    expect(result.current.card.utxoReadIncomplete).toBe(false)
    expect(result.current.card.availableAmount).toBe('0.60000000')
  })
})

describe('startBalancePoll', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A background whose reads answer only when the test says. */
  function pendingBalanceReads() {
    const reads: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = []
    // A plain function, not a vi.fn: a spy would handle every rejection itself.
    const fetchBalance = (): Promise<any> =>
      new Promise((resolve, reject) => {
        reads.push({ resolve, reject })
      })
    return { reads, fetchBalance }
  }

  /** What a caller of `read()` gets: the answer, or the error's name and message. */
  const outcomeOf = (reading: Promise<unknown>): Promise<string> =>
    reading.then(
      () => 'answered',
      (error: Error) => `${error.name}: ${error.message}`
    )

  it.each<[string, (read: { resolve: (value: unknown) => void; reject: (error: Error) => void }) => void]>([
    ['answers', read => read.resolve(fullRead)],
    ['fails', read => read.reject(new Error('the answer was lost'))],
  ])(
    "rejects the promise of a read it gives up on with a named error, and that read's late outcome, when it %s, reaches no one",
    async (_how, settleLate) => {
      vi.useFakeTimers()
      const background = pendingBalanceReads()
      const balancePoll = startBalancePoll(background.fetchBalance)

      const unhandled = await unhandledRejectionsDuring(async () => {
        let outcome: string | undefined
        void outcomeOf(balancePoll.read()).then(value => (outcome = value))
        await vi.advanceTimersByTimeAsync(59_999)
        expect(outcome).toBeUndefined()
        await vi.advanceTimersByTimeAsync(1)
        expect(outcome).toBe('BalanceReadGaveUpError: balance read gave up after 60 s')

        // Its answer turns up at 65 s: nothing changes, and the next read
        // still comes 10 s after the give-up.
        await vi.advanceTimersByTimeAsync(5_000)
        settleLate(background.reads[0])
        await vi.advanceTimersByTimeAsync(4_999)
        expect(background.reads).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(1)
        expect(background.reads).toHaveLength(2)
        balancePoll.stop()
      })
      expect(unhandled).toEqual([])
    }
  )

  it('rejects the promise of each read still in flight when it stops, and leaves no timer', async () => {
    vi.useFakeTimers()
    const background = pendingBalanceReads()
    const balancePoll = startBalancePoll(background.fetchBalance)

    const unhandled = await unhandledRejectionsDuring(async () => {
      const outcomes = [balancePoll.read(), balancePoll.read()].map(outcomeOf)
      await vi.advanceTimersByTimeAsync(5_000)
      balancePoll.stop()

      expect(await Promise.all(outcomes)).toEqual([
        'BalanceReadGaveUpError: balance read gave up: the card stopped polling',
        'BalanceReadGaveUpError: balance read gave up: the card stopped polling',
      ])
      expect(vi.getTimerCount()).toBe(0)
      // Their answers, when they come, reach no one either.
      background.reads[0].resolve(fullRead)
      background.reads[1].reject(new Error('the answer was lost'))
    })
    expect(unhandled).toEqual([])
  })
})
