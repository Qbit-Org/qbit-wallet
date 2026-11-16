import { configureStore } from '@reduxjs/toolkit'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { KeyringType } from '@qbit/wallet-shared'
import { AddressType } from '@qbit/wallet-types'

import accounts, { accountActions } from '../../src/reducers/accounts'
import global from '../../src/reducers/global'
import keyrings, { keyringsActions } from '../../src/reducers/keyrings'
import settings from '../../src/reducers/settings'
import transactions from '../../src/reducers/transactions'
import ui from '../../src/reducers/ui'
import { useAddressTypeScreenLogic } from '../../src/ui-hooks/useAddressTypeScreenLogic'
import { createHookTestHarness, createWalletMock } from './testHelpers'

function accountAt(index: number) {
  return {
    type: KeyringType.HdKeyring,
    address: `qb1ztestaccount${index}`,
    brandName: 'Qbit',
    alianName: 'Account',
    displayBrandName: 'Qbit',
    index,
    balance: 0,
    pubkey: `02abc12${index}`,
    key: `account-${index}`,
    flag: 0,
  }
}

const ACCOUNT = accountAt(0)

function keyring(key: string) {
  return {
    key,
    index: 0,
    type: KeyringType.HdKeyring,
    addressType: AddressType.P2TR,
    accounts: [ACCOUNT, accountAt(1)],
    alianName: 'HD Wallet #1',
    color: 'green',
    hdPath: '',
  }
}

/** A page's store before its wallet has loaded: no current wallet or account. */
function createStoreWithoutWallet() {
  return configureStore({
    reducer: { accounts, transactions, settings, global, keyrings, ui },
  })
}

function summaries(addresses: string[]) {
  return addresses.map(address => ({ address, totalSatoshis: 0 }))
}

function walletAnswering(addresses: string[]) {
  return {
    ...createWalletMock(),
    getAllAddresses: vi.fn().mockResolvedValue(addresses),
    getMultiAddressSummaries: vi.fn().mockResolvedValue(summaries(addresses)),
  }
}

describe('useAddressTypeScreenLogic: reading the addresses', () => {
  it('reads them once when the screen opens with its wallet loaded', async () => {
    const wallet = walletAnswering(['a0', 'a1', 'a2'])
    const { wrapper, store } = createHookTestHarness({ wallet })
    renderHook(() => useAddressTypeScreenLogic(), { wrapper })

    await waitFor(() => expect(wallet.getMultiAddressSummaries).toHaveBeenCalledTimes(1))
    expect(wallet.getAllAddresses).toHaveBeenCalledTimes(1)
    expect(wallet.getAllAddresses).toHaveBeenCalledWith(store.getState().keyrings.current, 0)
  })

  it('asks for nothing while the page has no wallet yet, and reads once the wallet has loaded', async () => {
    const wallet = walletAnswering(['a0', 'a1', 'a2'])
    const store = createStoreWithoutWallet()
    const { wrapper } = createHookTestHarness({ wallet, store: store as never })
    renderHook(() => useAddressTypeScreenLogic(), { wrapper })

    // Opened by its address or reloaded: the store's wallet has no key, and
    // the background refuses a read for it.
    expect(store.getState().keyrings.current.key).toBe('')
    await act(async () => {
      await Promise.resolve()
    })
    expect(wallet.getAllAddresses).not.toHaveBeenCalled()

    act(() => {
      store.dispatch(accountActions.setCurrent(ACCOUNT))
      store.dispatch(keyringsActions.setCurrent(keyring('keyring-1')))
    })

    await waitFor(() => expect(wallet.getMultiAddressSummaries).toHaveBeenCalledTimes(1))
    expect(wallet.getAllAddresses).toHaveBeenCalledTimes(1)
    expect(wallet.getAllAddresses).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'keyring-1' }),
      0
    )
  })

  it('reads again for another wallet, and shows nothing of a read the next one overtook', async () => {
    let answerFirst: (addresses: string[]) => void = () => {}
    const wallet = {
      ...createWalletMock(),
      getAllAddresses: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<string[]>(resolve => {
              answerFirst = resolve
            })
        )
        .mockResolvedValue(['second']),
      getMultiAddressSummaries: vi.fn((joined: string) =>
        Promise.resolve(summaries(joined.split(',')))
      ),
    }
    const { wrapper, store, tools } = createHookTestHarness({ wallet })
    renderHook(() => useAddressTypeScreenLogic(), { wrapper })
    await waitFor(() => expect(wallet.getAllAddresses).toHaveBeenCalledTimes(1))

    act(() => {
      store.dispatch(keyringsActions.setCurrent(keyring('keyring-2')))
    })
    await waitFor(() => expect(wallet.getMultiAddressSummaries).toHaveBeenCalledWith('second'))
    await waitFor(() => expect(tools.showLoading).toHaveBeenLastCalledWith(false))

    // The first wallet's read answers only now: its addresses are not asked
    // about, and it does not end a loading state that is no longer its own.
    const loadingCalls = vi.mocked(tools.showLoading).mock.calls.length
    await act(async () => {
      answerFirst(['first'])
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(wallet.getMultiAddressSummaries).toHaveBeenCalledTimes(1)
    expect(wallet.getMultiAddressSummaries).not.toHaveBeenCalledWith('first')
    expect(vi.mocked(tools.showLoading).mock.calls.length).toBe(loadingCalls)
  })
})

/** The addresses of each wallet and account, one per address type value. */
const ADDRESSES: Record<string, string[]> = {
  'keyring-1/0': ['w1-0', 'w1-1', 'w1-2', 'w1-3', 'w1-4', 'w1-5'],
  'keyring-2/0': ['w2-0', 'w2-1', 'w2-2', 'w2-3', 'w2-4', 'w2-5'],
  'keyring-1/1': ['a1-0', 'a1-1', 'a1-2', 'a1-3', 'a1-4', 'a1-5'],
}
/** Only the BIP44 P2WPKH address of wallet 2, and of wallet 1's second account, holds funds. */
const FUNDED = new Set(['w2-4', 'a1-4'])

function walletWithFunds() {
  return {
    ...createWalletMock(),
    getAllAddresses: vi.fn((asked: { key: string }, index: number) =>
      Promise.resolve(ADDRESSES[`${asked.key}/${index}`] ?? [])
    ),
    // Answered a task later, as a read over the port and the network is: a
    // balance set from the same object as the last read's would not show.
    getMultiAddressSummaries: vi.fn(
      (joined: string) =>
        new Promise(resolve =>
          setTimeout(
            () =>
              resolve(
                joined
                  .split(',')
                  .map(address => ({ address, totalSatoshis: FUNDED.has(address) ? 100000 : 0 }))
              ),
            5
          )
        )
    ),
  }
}

describe('useAddressTypeScreenLogic: a read made again', () => {
  it("shows another wallet's balances, and its funded BIP44 type, after the first wallet's read", async () => {
    const wallet = walletWithFunds()
    const { wrapper, store } = createHookTestHarness({ wallet: wallet as never })
    const { result } = renderHook(() => useAddressTypeScreenLogic(), { wrapper })

    // Wallet 1 holds nothing on its BIP44 address: that type is not listed.
    await waitFor(() => expect(result.current.items[0]?.assets.totalAmount).toBe('0.00000000'))
    expect(result.current.items.map(item => item.value)).not.toContain(AddressType.BIP44_P2WPKH)

    act(() => {
      store.dispatch(keyringsActions.setCurrent(keyring('keyring-2')))
    })

    await waitFor(() =>
      expect(result.current.items.map(item => item.value)).toContain(AddressType.BIP44_P2WPKH)
    )
    const funded = result.current.items.find(item => item.value === AddressType.BIP44_P2WPKH)
    expect(funded).toMatchObject({ address: 'w2-4', assets: { satoshis: 100000 } })
    expect(result.current.items.every(item => item.address.startsWith('w2-'))).toBe(true)
    expect(result.current.items.every(item => item.assets.totalAmount !== '--')).toBe(true)
  })

  it("reads again for another account of the wallet, and shows that account's addresses and paths", async () => {
    const wallet = walletWithFunds()
    const { wrapper, store } = createHookTestHarness({ wallet: wallet as never })
    const { result } = renderHook(() => useAddressTypeScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.items[0]?.assets.totalAmount).toBe('0.00000000'))
    expect(wallet.getAllAddresses).toHaveBeenLastCalledWith(expect.anything(), 0)

    act(() => {
      store.dispatch(accountActions.setCurrent(accountAt(1)))
    })

    await waitFor(() =>
      expect(result.current.items.map(item => item.value)).toContain(AddressType.BIP44_P2WPKH)
    )
    expect(wallet.getAllAddresses).toHaveBeenLastCalledWith(expect.anything(), 1)
    expect(result.current.items.every(item => item.address.startsWith('a1-'))).toBe(true)
    // The path each type is listed with ends in the account's index.
    expect(result.current.items.every(item => /\/1\)$/.test(item.name))).toBe(true)
  })

  it('shows nothing of the account read before when the read for another account fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wallet = walletWithFunds()
    const { wrapper, store, tools } = createHookTestHarness({ wallet: wallet as never })
    const { result } = renderHook(() => useAddressTypeScreenLogic(), { wrapper })
    await waitFor(() => expect(result.current.items[0]?.assets.totalAmount).toBe('0.00000000'))
    expect(result.current.items.every(item => item.address.startsWith('w1-'))).toBe(true)

    wallet.getAllAddresses.mockRejectedValueOnce(new Error('Unknown wallet'))
    act(() => {
      store.dispatch(accountActions.setCurrent(accountAt(1)))
    })

    await waitFor(() =>
      expect(wallet.getAllAddresses).toHaveBeenLastCalledWith(expect.anything(), 1)
    )
    await waitFor(() => expect(tools.showLoading).toHaveBeenLastCalledWith(false))
    // The paths are the second account's; no address or balance of the first stays beside them.
    expect(result.current.items.length).toBeGreaterThan(0)
    expect(result.current.items.every(item => item.address === undefined)).toBe(true)
    expect(result.current.items.every(item => item.assets.totalAmount === '--')).toBe(true)
    errorSpy.mockRestore()
  })

  it('shows nothing of an overtaken read whose balances answer after the next read ended', async () => {
    let answerFirstBalances: (value: unknown) => void = () => {}
    const wallet = walletWithFunds()
    wallet.getMultiAddressSummaries.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          answerFirstBalances = resolve
        })
    )
    const { wrapper, store, tools } = createHookTestHarness({ wallet: wallet as never })
    const { result } = renderHook(() => useAddressTypeScreenLogic(), { wrapper })
    await waitFor(() => expect(wallet.getMultiAddressSummaries).toHaveBeenCalledTimes(1))

    act(() => {
      store.dispatch(keyringsActions.setCurrent(keyring('keyring-2')))
    })
    await waitFor(() =>
      expect(result.current.items.map(item => item.value)).toContain(AddressType.BIP44_P2WPKH)
    )
    await waitFor(() => expect(tools.showLoading).toHaveBeenLastCalledWith(false))
    const shown = result.current.items.map(item => [item.address, item.assets.totalAmount])

    // Wallet 1's balances answer only now, with funds on every address.
    await act(async () => {
      answerFirstBalances(
        ADDRESSES['keyring-1/0']!.map(address => ({ address, totalSatoshis: 999 }))
      )
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(result.current.items.map(item => [item.address, item.assets.totalAmount])).toEqual(shown)
    expect(result.current.items.every(item => item.address.startsWith('w2-'))).toBe(true)
  })
})
