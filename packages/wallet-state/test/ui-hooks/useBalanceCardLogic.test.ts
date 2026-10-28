import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChainType } from '@qbit/wallet-types'

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
