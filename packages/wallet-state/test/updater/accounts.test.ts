import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useStartBalanceReadCallback } from '../../src/hooks/accounts'
import { accountActions } from '../../src/reducers/accounts'
import { globalActions } from '../../src/reducers/global'
import { AccountUpdater } from '../../src/updater/accounts'
import { createHookTestHarness, createWalletMock } from '../ui-hooks/testHelpers'

function renderUpdaterWithSlowExplorer() {
  const failFetch: Array<() => void> = []
  const wallet = {
    ...createWalletMock(),
    // Every balance fetch stays in flight until the test fails it.
    getAddressBalanceV2: vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          failFetch.push(() => reject(new Error('explorer down')))
        })
    ),
    // reloadAccounts runs on account changes; keep it from replacing the test's account.
    getKeyrings: vi.fn(() => new Promise<never>(() => undefined)),
  }
  const { store, wrapper } = createHookTestHarness({ wallet: wallet as any })
  store.dispatch(globalActions.update({ isUnlocked: true }))
  renderHook(() => AccountUpdater(), { wrapper })
  // Another caller of the page that reads the account (a refresh after a broadcast).
  const other = renderHook(() => useStartBalanceReadCallback(), { wrapper })

  const selectAccount = (address: string, key: string) =>
    act(() => {
      store.dispatch(accountActions.setCurrent({ address, key } as any))
    })
  // Re-runs the fetch effect for the same account; `whileLocked` runs between.
  const lockAndUnlock = (whileLocked?: () => void) => {
    act(() => {
      store.dispatch(globalActions.update({ isUnlocked: false }))
    })
    if (whileLocked) act(whileLocked)
    act(() => {
      store.dispatch(globalActions.update({ isUnlocked: true }))
    })
  }
  const readElsewhere = () => {
    other.result.current().catch(() => undefined)
  }
  return { wallet, failFetch, selectAccount, lockAndUnlock, readElsewhere }
}

describe('AccountUpdater', () => {
  it('fetches a newly selected account while the previous account is still loading', () => {
    const { wallet, selectAccount } = renderUpdaterWithSlowExplorer()
    const asked = { progressId: expect.any(String) }
    expect(wallet.getAddressBalanceV2).toHaveBeenCalledWith('qb1ztestaccount', asked)

    selectAccount('qb1zotheraccount', 'account-2')

    expect(wallet.getAddressBalanceV2).toHaveBeenCalledTimes(2)
    expect(wallet.getAddressBalanceV2).toHaveBeenLastCalledWith('qb1zotheraccount', asked)
  })

  it('does not fetch the same account again while its fetch is in flight', () => {
    const { wallet, lockAndUnlock, readElsewhere } = renderUpdaterWithSlowExplorer()

    // A read of the account begun while the wallet was locked is still in
    // flight at the unlock: it is the account's read.
    lockAndUnlock(readElsewhere)

    expect(wallet.getAddressBalanceV2).toHaveBeenCalledTimes(2)
  })

  it('reads the account at an unlock when the read in flight began before the lock, as its answer is from before it', () => {
    const { wallet, lockAndUnlock } = renderUpdaterWithSlowExplorer()

    lockAndUnlock()

    expect(wallet.getAddressBalanceV2).toHaveBeenCalledTimes(2)
  })

  it('reads an account selected again once: not while its read is in flight, and again once it settled', async () => {
    const { wallet, failFetch, selectAccount } = renderUpdaterWithSlowExplorer()
    selectAccount('qb1zotheraccount', 'account-2')
    selectAccount('qb1ztestaccount', 'account-1')
    // The first account's read is still in flight: it is not read beside it.
    expect(wallet.getAddressBalanceV2).toHaveBeenCalledTimes(2)
    selectAccount('qb1zotheraccount', 'account-2')
    expect(wallet.getAddressBalanceV2).toHaveBeenCalledTimes(2)

    // Once it failed, selecting it again reads it again.
    await act(async () => {
      failFetch[0]()
    })
    selectAccount('qb1ztestaccount', 'account-1')

    expect(wallet.getAddressBalanceV2).toHaveBeenCalledTimes(3)
  })
})
