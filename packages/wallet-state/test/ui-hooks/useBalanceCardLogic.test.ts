import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChainType } from '@qbit/wallet-types'

import { AddressType } from '@qbit/wallet-types'

import { useFetchBalanceCallback } from '../../src/hooks/accounts'
import { useFetchUtxosCallback, usePushQbitTxCallback } from '../../src/hooks/transactions'
import {
  BALANCE_CARD_OUTPUT_READ_MAX_AGE_MS,
  useBalanceCardLogic,
} from '../../src/ui-hooks/useBalanceCardLogic'
import { accountActions } from '../../src/reducers/accounts'
import { settingsActions } from '../../src/reducers/settings'
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

describe("useBalanceCardLogic past the explorer's limit, with the send screen's output read", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const otherAddress = 'qbit-another-account'
  const overLimitBalance = {
    availableBalance: null,
    unavailableBalance: 91_000_000,
    totalBalance: 91_000_000,
    immatureBalance: null,
    pendingBalance: null,
    utxoLimitExceeded: true,
    chainType: ChainType.QBIT_MAINNET,
  }

  function outputs(txidByte: string, values: number[]) {
    return values.map((satoshis, vout) => ({
      txid: txidByte.repeat(32),
      vout,
      satoshis,
      scriptPk: `5220${'aa'.repeat(32)}`,
      pubkey: '11'.repeat(32),
      addressType: AddressType.P2MR,
    }))
  }

  /**
   * The card for `address` with an over-limit balance, next to the send
   * screen's output read and a broadcast from this window.
   */
  function renderOverLimitCard(balance: Record<string, unknown> = overLimitBalance) {
    const wallet = {
      ...createWalletMock(),
      getAddressSummary: vi.fn().mockResolvedValue(summary),
      getAddressBalanceV2: vi.fn().mockResolvedValue(balance),
      broadcastQbitTx: vi.fn().mockResolvedValue({
        success: true,
        chain: ChainType.QBIT_MAINNET,
        txid: 'cd'.repeat(32),
        via: 'broadcast',
      }),
    }
    const harness = createHookTestHarness({ wallet: wallet as any })
    const select = (selected: string, chainType = ChainType.QBIT_MAINNET) => {
      harness.store.dispatch(settingsActions.updateSettings({ chainType }))
      harness.store.dispatch(
        accountActions.setCurrent({
          address: selected,
          pubkey: '11'.repeat(32),
          type: 'Qbit HD Key Tree',
        } as any)
      )
      harness.store.dispatch(
        accountActions.setBalanceV2({
          address: selected,
          balance: { ...balance, chainType } as any,
        })
      )
    }
    select(address)
    const { result } = renderHook(
      () => ({
        card: useBalanceCardLogic(),
        readOutputs: useFetchUtxosCallback(),
        broadcast: usePushQbitTxCallback(),
      }),
      { wrapper: harness.wrapper }
    )
    /** The send screen's read, answered with `utxos` for the selected account and network. */
    const readOutputs = async (utxos: ReturnType<typeof outputs>) => {
      const { accounts, settings } = harness.store.getState()
      wallet.getQbitUtxoSnapshot.mockResolvedValueOnce({
        address: accounts.current.address,
        chain: settings.chainType,
        utxos,
      })
      await act(async () => {
        await result.current.readOutputs()
      })
    }
    /** A send from this window; call with fake timers, past the push's wait. */
    const broadcast = async () => {
      await act(async () => {
        const pushed = result.current.broadcast({ psbtHex: 'signed-rawtx' })
        await vi.advanceTimersByTimeAsync(3000)
        await pushed
      })
    }
    return { ...harness, wallet, result, select, readOutputs, broadcast }
  }

  type Card = ReturnType<typeof useBalanceCardLogic>
  const expectSplit = (card: Card, available: string, unavailable: string) => {
    expect(card.availableAmount).toBe(available)
    expect(card.unavailableAmount).toBe(unavailable)
    expect(card.balanceSplitUnknown).toBe(false)
  }
  const expectUnknownSplit = (card: Card) => {
    expect(card.availableBalance).toBeNull()
    expect(card.unavailableBalance).toBeNull()
    expect(card.availableAmount).toBe('--')
    expect(card.unavailableAmount).toBe('--')
  }

  it('shows the split from the send screen read for the same account and network', async () => {
    const { result, readOutputs } = renderOverLimitCard()
    expectUnknownSplit(result.current.card)
    expect(result.current.card.balanceSplitUnknown).toBe(true)

    await readOutputs(outputs('aa', [40_000_000, 20_000_000]))

    expect(result.current.card.balanceValue).toBe('0.91000000')
    expect(result.current.card.availableBalance).toBe(60_000_000)
    expect(result.current.card.unavailableBalance).toBe(31_000_000)
    expectSplit(result.current.card, '0.60000000', '0.31000000')
    // The total still comes from the address statistics.
    expect(result.current.card.utxoLimitExceeded).toBe(true)
  })

  it("keeps `--` for another account's read", async () => {
    const { result, select, readOutputs } = renderOverLimitCard()
    act(() => select(otherAddress))
    await readOutputs(outputs('bb', [40_000_000]))
    // The read itself is one the card would use for that account.
    expectSplit(result.current.card, '0.40000000', '0.51000000')

    act(() => select(address))

    expect(result.current.card.balanceValue).toBe('0.91000000')
    expectUnknownSplit(result.current.card)
    expect(result.current.card.balanceSplitUnknown).toBe(true)
  })

  it("keeps `--` for the same account's read on another network", async () => {
    const { result, select, readOutputs } = renderOverLimitCard()
    act(() => select(address, ChainType.QBIT_TESTNET4))
    await readOutputs(outputs('bb', [40_000_000]))
    expectSplit(result.current.card, '0.40000000', '0.51000000')

    act(() => select(address, ChainType.QBIT_MAINNET))

    expect(result.current.card.balanceValue).toBe('0.91000000')
    expectUnknownSplit(result.current.card)
  })

  it('falls back to `--` after a broadcast, until a read started after it', async () => {
    vi.useFakeTimers()
    const { result, readOutputs, broadcast } = renderOverLimitCard()
    await readOutputs(outputs('aa', [40_000_000, 20_000_000]))
    expectSplit(result.current.card, '0.60000000', '0.31000000')

    await broadcast()

    expectUnknownSplit(result.current.card)
    expect(result.current.card.balanceSplitUnknown).toBe(true)

    await readOutputs(outputs('ee', [20_000_000, 9_000_000]))
    expectSplit(result.current.card, '0.29000000', '0.62000000')
  })

  it('does not take a read that started before a broadcast and landed after it', async () => {
    vi.useFakeTimers()
    const { result, wallet, broadcast } = renderOverLimitCard()
    let answer!: (snapshot: unknown) => void
    wallet.getQbitUtxoSnapshot.mockReturnValueOnce(new Promise(resolve => (answer = resolve)))
    let read!: Promise<unknown>
    act(() => {
      read = result.current.readOutputs()
    })

    await broadcast()
    await act(async () => {
      answer({
        address,
        chain: ChainType.QBIT_MAINNET,
        utxos: outputs('aa', [40_000_000, 20_000_000]),
      })
      await read
    })

    expectUnknownSplit(result.current.card)
  })

  it('falls back to `--` once the read is older than the limit', async () => {
    vi.useFakeTimers()
    const { result, readOutputs } = renderOverLimitCard()
    // Off the 10-second balance poll, so only the read's age re-renders the card.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    await readOutputs(outputs('aa', [40_000_000, 20_000_000]))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BALANCE_CARD_OUTPUT_READ_MAX_AGE_MS - 1)
    })
    expectSplit(result.current.card, '0.60000000', '0.31000000')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expectUnknownSplit(result.current.card)
    expect(result.current.card.balanceSplitUnknown).toBe(true)
  })

  it('does not take a read already older than the limit when the card opens', async () => {
    vi.useFakeTimers()
    const { wrapper, result, readOutputs } = renderOverLimitCard()
    await readOutputs(outputs('aa', [40_000_000, 20_000_000]))
    expectSplit(result.current.card, '0.60000000', '0.31000000')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BALANCE_CARD_OUTPUT_READ_MAX_AGE_MS + 5_000)
    })

    const reopened = renderHook(() => useBalanceCardLogic(), { wrapper }).result

    expect(reopened.current.balanceValue).toBe('0.91000000')
    expectUnknownSplit(reopened.current)
  })

  it('never shows more available than the measured total', async () => {
    const { result, readOutputs } = renderOverLimitCard()

    await readOutputs(outputs('aa', [60_000_000, 35_000_000]))

    expect(result.current.card.availableBalance).toBe(91_000_000)
    expect(result.current.card.unavailableBalance).toBe(0)
    expectSplit(result.current.card, '0.91000000', '0.00000000')
  })

  it('shows a read with nothing spendable as 0 available', async () => {
    const { result, readOutputs } = renderOverLimitCard()

    await readOutputs([])

    expectSplit(result.current.card, '0.00000000', '0.91000000')
  })

  it('keeps `--` while a broadcast holds the send guard, read or not', async () => {
    const { result, readOutputs } = renderOverLimitCard({
      ...overLimitBalance,
      utxoLimitExceeded: undefined,
    })

    await readOutputs(outputs('aa', [40_000_000, 20_000_000]))

    expectUnknownSplit(result.current.card)
    expect(result.current.card.utxoLimitExceeded).toBe(false)
    expect(result.current.card.balanceSplitUnknown).toBe(false)
  })

  it('keeps `--` before a balance read succeeds, read or not', async () => {
    const { store, result, readOutputs } = renderOverLimitCard()
    act(() => {
      // As before the first read: nothing stored for the selected account.
      store.dispatch(
        accountActions.setCurrent({
          address: otherAddress,
          pubkey: '11'.repeat(32),
          type: 'Qbit HD Key Tree',
        } as any)
      )
    })

    await readOutputs(outputs('aa', [40_000_000]))

    expect(result.current.card.balanceValue).toBe('--')
    expectUnknownSplit(result.current.card)
    expect(result.current.card.balanceSplitUnknown).toBe(false)
  })
})
