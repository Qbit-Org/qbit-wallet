import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { accountActions } from '../../src/reducers/accounts'
import { globalActions } from '../../src/reducers/global'
import { AccountUpdater } from '../../src/updater/accounts'
import { createHookTestHarness, createWalletMock } from '../ui-hooks/testHelpers'

function renderUpdaterWithSlowExplorer() {
  const failFetch: Array<() => void> = []
  const wallet = {
    ...createWalletMock(),
    // Every balance fetch stays in flight until the test fails it.
    getAddressSummary: vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          failFetch.push(() => reject(new Error('explorer down')))
        })
    ),
    getAddressBalanceV2: vi.fn(),
    // reloadAccounts runs on account changes; keep it from replacing the test's account.
    getKeyrings: vi.fn(() => new Promise<never>(() => undefined)),
  }
  const { store, wrapper } = createHookTestHarness({ wallet: wallet as any })
  store.dispatch(globalActions.update({ isUnlocked: true }))
  renderHook(() => AccountUpdater(), { wrapper })

  const selectAccount = (address: string, key: string) =>
    act(() => {
      store.dispatch(accountActions.setCurrent({ address, key } as any))
    })
  // Re-runs the fetch effect for the same account.
  const lockAndUnlock = () => {
    act(() => {
      store.dispatch(globalActions.update({ isUnlocked: false }))
    })
    act(() => {
      store.dispatch(globalActions.update({ isUnlocked: true }))
    })
  }
  return { wallet, failFetch, selectAccount, lockAndUnlock }
}

describe('AccountUpdater', () => {
  it('fetches a newly selected account while the previous account is still loading', () => {
    const { wallet, selectAccount } = renderUpdaterWithSlowExplorer()
    expect(wallet.getAddressSummary).toHaveBeenCalledWith('qb1ztestaccount')

    selectAccount('qb1zotheraccount', 'account-2')

    expect(wallet.getAddressSummary).toHaveBeenCalledTimes(2)
    expect(wallet.getAddressSummary).toHaveBeenLastCalledWith('qb1zotheraccount')
  })

  it('does not fetch the same account again while its fetch is in flight', () => {
    const { wallet, lockAndUnlock } = renderUpdaterWithSlowExplorer()

    lockAndUnlock()

    expect(wallet.getAddressSummary).toHaveBeenCalledTimes(1)
  })

  it('keeps an account marked as loading when an older fetch for it settles', async () => {
    const { wallet, failFetch, selectAccount, lockAndUnlock } = renderUpdaterWithSlowExplorer()
    selectAccount('qb1zotheraccount', 'account-2')
    selectAccount('qb1ztestaccount', 'account-1')
    expect(wallet.getAddressSummary).toHaveBeenCalledTimes(3)

    // The account's first fetch fails while its second is still in flight.
    await act(async () => {
      failFetch[0]()
    })
    lockAndUnlock()

    expect(wallet.getAddressSummary).toHaveBeenCalledTimes(3)
  })
})
