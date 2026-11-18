import { configureStore } from '@reduxjs/toolkit'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { KeyringType } from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'

import accounts, { accountActions } from '../../src/reducers/accounts'
import global from '../../src/reducers/global'
import keyrings, { keyringsActions } from '../../src/reducers/keyrings'
import settings, { settingsActions } from '../../src/reducers/settings'
import transactions from '../../src/reducers/transactions'
import ui, { uiActions } from '../../src/reducers/ui'
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

describe('useAddressTypeScreenLogic: hidden balances', () => {
  it('says whether balances are hidden, as the store does, so the cards can hide theirs', async () => {
    const wallet = walletAnswering(['a0', 'a1', 'a2'])
    const { wrapper, store } = createHookTestHarness({ wallet })
    const { result } = renderHook(() => useAddressTypeScreenLogic(), { wrapper })
    await waitFor(() => expect(wallet.getMultiAddressSummaries).toHaveBeenCalledTimes(1))

    expect(result.current.balanceHidden).toBe(false)
    act(() => {
      store.dispatch(uiActions.setBalanceHidden(true))
    })
    expect(result.current.balanceHidden).toBe(true)
    act(() => {
      store.dispatch(uiActions.setBalanceHidden(false))
    })
    expect(result.current.balanceHidden).toBe(false)
  })
})

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

interface ScreenCase {
  type: string
  addressType: AddressType
  accountIndex?: number
  address?: string
  accountIndexDerivation?: boolean
  chainType?: ChainType
}

/**
 * The screen for the wallet `wallet` describes, its account current. The
 * background answers `listed` for its addresses and holds 100,000 sats on
 * each address of `funded`.
 */
function renderScreenFor(wallet: ScreenCase, listed: string[], funded: string[] = []) {
  const background = {
    ...createWalletMock(),
    getAllAddresses: vi.fn().mockResolvedValue(listed),
    getMultiAddressSummaries: vi.fn((joined: string) =>
      Promise.resolve(
        joined
          .split(',')
          .map(address => ({ address, totalSatoshis: funded.includes(address) ? 100000 : 0 }))
      )
    ),
  }
  const harness = createHookTestHarness({ wallet: background as never })
  if (wallet.chainType) {
    harness.store.dispatch(settingsActions.updateSettings({ chainType: wallet.chainType }))
  }
  const account = {
    ...accountAt(wallet.accountIndex ?? 0),
    type: wallet.type,
    ...(wallet.address !== undefined ? { address: wallet.address } : {}),
  }
  harness.store.dispatch(accountActions.setCurrent(account))
  harness.store.dispatch(
    keyringsActions.setCurrent({
      key: 'keyring-1',
      index: 0,
      type: wallet.type,
      addressType: wallet.addressType,
      accounts: [account],
      alianName: 'Wallet 1',
      color: 'green',
      hdPath: '',
      ...(wallet.accountIndexDerivation ? { accountIndexDerivation: true } : {}),
    })
  )
  const view = renderHook(() => useAddressTypeScreenLogic(), { wrapper: harness.wrapper })
  return { ...harness, ...view, background }
}

/**
 * Holds each balance read from here on until the test answers it: the
 * answers, in the order the reads were asked.
 */
function holdBalances(background: ReturnType<typeof renderScreenFor>['background']) {
  const answers: ((value: unknown) => void)[] = []
  background.getMultiAddressSummaries.mockImplementation(
    () =>
      new Promise(resolve => {
        answers.push(resolve)
      }) as never
  )
  return answers
}

const EMPTY = { totalAmount: '0.00000000', satoshis: 0 }
const FUNDS = { totalAmount: '0.00100000', satoshis: 100000 }

// What a wallet that can change type lists, pinned as it was before the
// screen learned the Qbit wallet's path and address: its addresses stand in
// the list at the position of their type's value.
describe('useAddressTypeScreenLogic: what a wallet that can change type lists', () => {
  const HD_LIST = ['h0', 'h1', 'h2', 'h3', 'h4', 'h5']

  it.each([ChainType.QBIT_MAINNET, ChainType.QBIT_TESTNET4, ChainType.QBIT_REGTEST])(
    'an HD wallet on %s: its four types, and a BIP44 type only where it holds funds',
    async chainType => {
      const { result, background } = renderScreenFor(
        { type: KeyringType.HdKeyring, addressType: AddressType.P2TR, chainType },
        HD_LIST,
        ['h4']
      )

      await waitFor(() => expect(result.current.items).toHaveLength(5))
      expect(background.getMultiAddressSummaries).toHaveBeenCalledWith(HD_LIST.join(','))
      expect(result.current.items).toEqual([
        {
          value: AddressType.P2WPKH,
          name: "Native Segwit (P2WPKH) (m/84'/0'/0'/0/0)",
          address: 'h1',
          assets: EMPTY,
        },
        {
          value: AddressType.P2SH_P2WPKH,
          name: "Nested Segwit (P2SH-P2WPKH) (m/49'/0'/0'/0/0)",
          address: 'h3',
          assets: EMPTY,
        },
        {
          value: AddressType.P2TR,
          name: "Taproot (P2TR) (m/86'/0'/0'/0/0)",
          address: 'h2',
          assets: EMPTY,
        },
        { value: AddressType.P2PKH, name: "P2PKH (m/44'/0'/0'/0/0)", address: 'h0', assets: EMPTY },
        {
          value: AddressType.BIP44_P2WPKH,
          name: "Native SegWit (P2WPKH) (m/44'/0'/0'/0/0)",
          address: 'h4',
          assets: FUNDS,
        },
      ])
    }
  )

  it('an HD wallet that numbers its accounts in the account segment: P2WPKH and P2TR', async () => {
    const { result } = renderScreenFor(
      {
        type: KeyringType.HdKeyring,
        addressType: AddressType.P2WPKH,
        accountIndex: 2,
        accountIndexDerivation: true,
      },
      HD_LIST
    )

    await waitFor(() => expect(result.current.items[0]?.assets).toEqual(EMPTY))
    expect(result.current.items).toEqual([
      {
        value: AddressType.P2WPKH,
        name: "Native Segwit (P2WPKH) (m/84'/0'/2'/0/0)",
        address: 'h1',
        assets: EMPTY,
      },
      {
        value: AddressType.P2TR,
        name: "Taproot (P2TR) (m/86'/0'/2'/0/0)",
        address: 'h2',
        assets: EMPTY,
      },
    ])
  })

  it.each([
    [
      KeyringType.SimpleKeyring,
      ['Native Segwit (P2WPKH)', 'Nested Segwit (P2SH-P2WPKH)', 'Taproot (P2TR)', 'P2PKH'],
    ],
    [
      KeyringType.ReadonlyKeyring,
      [
        "Native Segwit (P2WPKH) (m/84'/0'/0'/0/0)",
        "Nested Segwit (P2SH-P2WPKH) (m/49'/0'/0'/0/0)",
        "Taproot (P2TR) (m/86'/0'/0'/0/0)",
        "P2PKH (m/44'/0'/0'/0/0)",
      ],
    ],
  ])('a %s wallet: the four types, each with its address', async (type, names) => {
    const { result } = renderScreenFor({ type, addressType: AddressType.P2WPKH }, [
      's0',
      's1',
      's2',
      's3',
    ])

    await waitFor(() => expect(result.current.items[0]?.assets).toEqual(EMPTY))
    expect(result.current.items).toEqual([
      { value: AddressType.P2WPKH, name: names[0], address: 's1', assets: EMPTY },
      { value: AddressType.P2SH_P2WPKH, name: names[1], address: 's3', assets: EMPTY },
      { value: AddressType.P2TR, name: names[2], address: 's2', assets: EMPTY },
      { value: AddressType.P2PKH, name: names[3], address: 's0', assets: EMPTY },
    ])
  })
})

// A wallet with one fixed type lists that type, with the account's own
// address: the background's list for it does not say which type an entry is
// (the Qbit wallet's one P2MR address stands first, not at P2MR's value).
describe('useAddressTypeScreenLogic: a wallet with one fixed type', () => {
  const QBIT_ADDRESS = 'qbrt1zqbitaccount'

  it.each([
    [ChainType.QBIT_MAINNET, "Post-Quantum P2MR (m/87'/0'/0'/0/2)"],
    [ChainType.QBIT_TESTNET4, "Post-Quantum P2MR (m/87'/1'/0'/0/2)"],
    [ChainType.QBIT_REGTEST, "Post-Quantum P2MR (m/87'/1'/0'/0/2)"],
  ])(
    'the Qbit wallet on %s: its P2MR type on the path it derives on there',
    async (chainType, name) => {
      const { result } = renderScreenFor(
        {
          type: KeyringType.QbitHdKeyring,
          addressType: AddressType.P2MR,
          accountIndex: 2,
          address: QBIT_ADDRESS,
          chainType,
        },
        [QBIT_ADDRESS]
      )

      await waitFor(() => expect(result.current.items[0]?.assets).toEqual(EMPTY))
      expect(result.current.items).toEqual([
        { value: AddressType.P2MR, name, address: QBIT_ADDRESS, assets: EMPTY },
      ])
    }
  )

  it("the Qbit wallet: the account's address and its balance", async () => {
    const { result, background } = renderScreenFor(
      {
        type: KeyringType.QbitHdKeyring,
        addressType: AddressType.P2MR,
        address: QBIT_ADDRESS,
        chainType: ChainType.QBIT_REGTEST,
      },
      // What the background lists for it: the one P2MR address, first.
      [QBIT_ADDRESS],
      [QBIT_ADDRESS]
    )

    await waitFor(() => expect(result.current.items[0]?.assets).toEqual(FUNDS))
    expect(result.current.items).toEqual([
      {
        value: AddressType.P2MR,
        name: "Post-Quantum P2MR (m/87'/1'/0'/0/0)",
        address: QBIT_ADDRESS,
        assets: FUNDS,
      },
    ])
    expect(background.getMultiAddressSummaries).toHaveBeenCalledTimes(1)
    expect(background.getMultiAddressSummaries).toHaveBeenCalledWith(QBIT_ADDRESS)
    // Its list says nothing the account does not.
    expect(background.getAllAddresses).not.toHaveBeenCalled()
  })

  it.each([
    [KeyringType.WatchAddressKeyring, AddressType.P2TR, "Taproot (P2TR) (m/86'/0'/0'/0/0)"],
    [
      KeyringType.ColdWalletKeyring,
      AddressType.P2WPKH,
      "❄️ Native Segwit (P2WPKH) (m/84'/0'/0'/0/0) - Fixed by cold wallet",
    ],
  ])(
    'a %s wallet: its type, with the account address and balance',
    async (type, addressType, name) => {
      const { result, background } = renderScreenFor(
        { type, addressType, address: 'bc1pwatched' },
        // Derived by the background from a public key such an account has not.
        ['', '', '', ''],
        ['bc1pwatched']
      )

      await waitFor(() => expect(result.current.items[0]?.assets).toEqual(FUNDS))
      expect(result.current.items).toEqual([
        { value: addressType, name, address: 'bc1pwatched', assets: FUNDS },
      ])
      expect(background.getMultiAddressSummaries).toHaveBeenCalledWith('bc1pwatched')
    }
  )

  it('reads again when the account address changes, as on another network, and shows nothing of the read before', async () => {
    let answerFirst: (value: unknown) => void = () => {}
    const { result, background, store } = renderScreenFor(
      {
        type: KeyringType.QbitHdKeyring,
        addressType: AddressType.P2MR,
        address: 'qb1zmainnet',
      },
      []
    )
    background.getMultiAddressSummaries.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          answerFirst = resolve
        })
    )
    await waitFor(() =>
      expect(background.getMultiAddressSummaries).toHaveBeenCalledWith('qb1zmainnet')
    )
    expect(result.current.items[0]?.name).toBe("Post-Quantum P2MR (m/87'/0'/0'/0/0)")

    // The wallets reloaded on the other network, as useReloadAccounts sets
    // them: the wallet, then its account.
    act(() => {
      const regtestAccount = { ...store.getState().accounts.current, address: QBIT_ADDRESS }
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_REGTEST }))
      store.dispatch(
        keyringsActions.setCurrent({
          ...store.getState().keyrings.current,
          accounts: [regtestAccount],
        })
      )
      store.dispatch(accountActions.setCurrent(regtestAccount))
    })

    await waitFor(() =>
      expect(result.current.items[0]).toMatchObject({ address: QBIT_ADDRESS, assets: EMPTY })
    )
    expect(result.current.items[0]?.name).toBe("Post-Quantum P2MR (m/87'/1'/0'/0/0)")

    // The Mainnet address's balance answers only now: it shows nowhere.
    await act(async () => {
      answerFirst([{ address: 'qb1zmainnet', totalSatoshis: 999 }])
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(result.current.items).toEqual([
      {
        value: AddressType.P2MR,
        name: "Post-Quantum P2MR (m/87'/1'/0'/0/0)",
        address: QBIT_ADDRESS,
        assets: EMPTY,
      },
    ])
  })

  it('reads the Qbit wallet again as the page hears of the network before its account, and shows nothing of the read in between', async () => {
    const { result, background, store } = renderScreenFor(
      {
        type: KeyringType.QbitHdKeyring,
        addressType: AddressType.P2MR,
        address: 'qb1zmainnet',
      },
      []
    )
    await waitFor(() =>
      expect(result.current.items[0]).toMatchObject({ address: 'qb1zmainnet', assets: EMPTY })
    )
    const answers = holdBalances(background)

    // As the page hears of another network: the network first, then the
    // wallets reloaded on it, the wallet before its account.
    act(() => {
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_REGTEST }))
    })
    // Asked on the new network for the address the account still has.
    await waitFor(() => expect(answers).toHaveLength(1))
    expect(background.getMultiAddressSummaries).toHaveBeenLastCalledWith('qb1zmainnet')
    expect(result.current.items[0]?.assets.totalAmount).toBe('--')

    const regtestAccount = { ...store.getState().accounts.current, address: QBIT_ADDRESS }
    act(() => {
      store.dispatch(
        keyringsActions.setCurrent({
          ...store.getState().keyrings.current,
          accounts: [regtestAccount],
        })
      )
    })
    // The wallet lists the account at another address: no address, nothing read.
    expect(result.current.items[0]?.address).toBeUndefined()
    act(() => {
      store.dispatch(accountActions.setCurrent(regtestAccount))
    })
    await waitFor(() => expect(answers).toHaveLength(2))
    expect(background.getMultiAddressSummaries).toHaveBeenLastCalledWith(QBIT_ADDRESS)

    await act(async () => {
      answers[1]!([{ address: QBIT_ADDRESS, totalSatoshis: 100000 }])
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    // The read in between answers only now: it shows nowhere.
    await act(async () => {
      answers[0]!([{ address: 'qb1zmainnet', totalSatoshis: 999 }])
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(result.current.items).toEqual([
      {
        value: AddressType.P2MR,
        name: "Post-Quantum P2MR (m/87'/1'/0'/0/0)",
        address: QBIT_ADDRESS,
        assets: FUNDS,
      },
    ])
  })

  it('has no address, and reads no balance, while its account has none', async () => {
    const { result, background, tools } = renderScreenFor(
      { type: KeyringType.QbitHdKeyring, addressType: AddressType.P2MR, address: '' },
      []
    )

    await waitFor(() => expect(tools.showLoading).toHaveBeenLastCalledWith(false))
    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0]?.address).toBeFalsy()
    expect(result.current.items[0]?.assets.totalAmount).toBe('--')
    expect(background.getAllAddresses).not.toHaveBeenCalled()
    expect(background.getMultiAddressSummaries).not.toHaveBeenCalled()
  })
})

// A page hears of an account made current in another window before it has
// that account's wallet: for a moment its store holds the wallet shown before
// with the other wallet's account.
describe('useAddressTypeScreenLogic: an account of another wallet', () => {
  const A_ACCOUNT = {
    ...accountAt(0),
    type: KeyringType.QbitHdKeyring,
    address: 'qbrt1zwalleta',
    key: 'keyring_0#0',
  }
  const B_ACCOUNT = {
    ...accountAt(0),
    type: KeyringType.HdKeyring,
    address: 'bcrt1qwalletb',
    key: 'keyring_1#0',
  }
  const WALLET_A = {
    key: 'keyring_0',
    index: 0,
    type: KeyringType.QbitHdKeyring,
    addressType: AddressType.P2MR,
    accounts: [A_ACCOUNT],
    alianName: 'Wallet A',
    color: 'green',
    hdPath: "m/87'/1'/0'/0",
  }
  const WALLET_B = {
    key: 'keyring_1',
    index: 1,
    type: KeyringType.HdKeyring,
    addressType: AddressType.P2WPKH,
    accounts: [B_ACCOUNT],
    alianName: 'Wallet B',
    color: 'blue',
    hdPath: '',
  }
  const B_LIST = ['b0', 'bcrt1qwalletb', 'b2', 'b3', 'b4', 'b5']

  function renderWalletA() {
    const background = {
      ...createWalletMock(),
      getAllAddresses: vi.fn((asked: { key: string }) =>
        Promise.resolve(asked.key === 'keyring_1' ? B_LIST : ['qbrt1zwalleta'])
      ),
      getMultiAddressSummaries: vi.fn((joined: string) =>
        Promise.resolve(
          joined.split(',').map(address => ({
            address,
            totalSatoshis: address === 'bcrt1qwalletb' ? 500000 : 0,
          }))
        )
      ),
    }
    const harness = createHookTestHarness({ wallet: background as never })
    harness.store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_REGTEST }))
    harness.store.dispatch(accountActions.setCurrent(A_ACCOUNT))
    harness.store.dispatch(keyringsActions.setCurrent(WALLET_A))
    const view = renderHook(() => useAddressTypeScreenLogic(), { wrapper: harness.wrapper })
    return { ...harness, ...view, background }
  }

  it("shows no address or balance of it on the card of the wallet shown, and that wallet's own list once the wallets reload", async () => {
    const { result, background, store, tools } = renderWalletA()
    await waitFor(() =>
      expect(result.current.items[0]).toMatchObject({ address: 'qbrt1zwalleta', assets: EMPTY })
    )

    // Wallet B's account, made current in another window, before wallet B.
    act(() => {
      store.dispatch(accountActions.setCurrent(B_ACCOUNT))
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    await waitFor(() => expect(tools.showLoading).toHaveBeenLastCalledWith(false))

    expect(result.current.items).toEqual([
      {
        value: AddressType.P2MR,
        name: "Post-Quantum P2MR (m/87'/1'/0'/0/0)",
        address: undefined,
        assets: { totalAmount: '--', satoshis: 0 },
      },
    ])
    expect(background.getMultiAddressSummaries).not.toHaveBeenCalledWith('bcrt1qwalletb')
    expect(background.getAllAddresses).not.toHaveBeenCalled()

    // The wallets reload: wallet B, and its account.
    act(() => {
      store.dispatch(keyringsActions.setCurrent(WALLET_B))
      store.dispatch(accountActions.setCurrent(B_ACCOUNT))
    })

    await waitFor(() => expect(result.current.items[0]?.address).toBe('bcrt1qwalletb'))
    expect(background.getAllAddresses).toHaveBeenCalledTimes(1)
    expect(background.getAllAddresses).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'keyring_1' }),
      0
    )
    expect(result.current.items.map(item => [item.value, item.address])).toEqual([
      [AddressType.P2WPKH, 'bcrt1qwalletb'],
      [AddressType.P2SH_P2WPKH, 'b3'],
      [AddressType.P2TR, 'b2'],
      [AddressType.P2PKH, 'b0'],
    ])
    await waitFor(() =>
      expect(result.current.items[0]?.assets).toEqual({
        totalAmount: '0.00500000',
        satoshis: 500000,
      })
    )
  })

  it('shows no address while the wallet shown lists the account at another address, as before it reloads on another network', async () => {
    const { result, background, store } = renderWalletA()
    await waitFor(() => expect(result.current.items[0]?.address).toBe('qbrt1zwalleta'))

    // The account on Mainnet, while the wallet still lists its Regtest address.
    act(() => {
      store.dispatch(accountActions.setCurrent({ ...A_ACCOUNT, address: 'qb1zwalleta' }))
    })
    await waitFor(() => expect(result.current.items[0]?.address).toBeUndefined())
    expect(background.getMultiAddressSummaries).not.toHaveBeenCalledWith('qb1zwalleta')
  })
})

// The balances are always those of the network the background is on: every
// wallet reads again on another one, also a watch or a cold wallet, whose
// account keeps the same address on every network.
describe('useAddressTypeScreenLogic: another network', () => {
  const OTHER_FUNDS = { totalAmount: '0.00250000', satoshis: 250000 }

  function onTestnet(store: ReturnType<typeof renderScreenFor>['store']) {
    act(() => {
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })
  }

  it.each([
    [KeyringType.WatchAddressKeyring, AddressType.P2TR],
    [KeyringType.ColdWalletKeyring, AddressType.P2WPKH],
  ])(
    "a %s wallet: shows nothing of the first network's balance, and the other network's once read",
    async (type, addressType) => {
      const { result, background, store } = renderScreenFor(
        { type, addressType, address: 'bc1pwatched', chainType: ChainType.QBIT_MAINNET },
        ['', '', '', ''],
        ['bc1pwatched']
      )
      await waitFor(() => expect(result.current.items[0]?.assets).toEqual(FUNDS))
      const answers = holdBalances(background)

      onTestnet(store)

      // Cleared at once, until the read on the other network answers.
      expect(result.current.items[0]).toMatchObject({
        address: undefined,
        assets: { totalAmount: '--', satoshis: 0 },
      })
      await waitFor(() => expect(answers).toHaveLength(1))
      expect(background.getMultiAddressSummaries).toHaveBeenCalledTimes(2)
      expect(background.getMultiAddressSummaries).toHaveBeenLastCalledWith('bc1pwatched')

      await act(async () => {
        answers[0]!([{ address: 'bc1pwatched', totalSatoshis: 250000 }])
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect(result.current.items[0]).toMatchObject({
        address: 'bc1pwatched',
        assets: OTHER_FUNDS,
      })
    }
  )

  it("a watch wallet: shows the other network's balance when the first network's read answers after it", async () => {
    const { result, background, store } = renderScreenFor(
      {
        type: KeyringType.WatchAddressKeyring,
        addressType: AddressType.P2TR,
        address: 'bc1pwatched',
        chainType: ChainType.QBIT_MAINNET,
      },
      ['', '', '', '']
    )
    const answers = holdBalances(background)
    await waitFor(() => expect(answers).toHaveLength(1))

    onTestnet(store)
    await waitFor(() => expect(answers).toHaveLength(2))

    await act(async () => {
      answers[1]!([{ address: 'bc1pwatched', totalSatoshis: 250000 }])
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(result.current.items[0]?.assets).toEqual(OTHER_FUNDS)

    // The first network's balance answers only now: it shows nowhere.
    await act(async () => {
      answers[0]!([{ address: 'bc1pwatched', totalSatoshis: 999 }])
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(result.current.items[0]).toMatchObject({
      address: 'bc1pwatched',
      assets: OTHER_FUNDS,
    })
  })

  it("a watch wallet: shows nothing of the first network's read that answers before the other network's", async () => {
    const { result, background, store } = renderScreenFor(
      {
        type: KeyringType.WatchAddressKeyring,
        addressType: AddressType.P2TR,
        address: 'bc1pwatched',
        chainType: ChainType.QBIT_MAINNET,
      },
      ['', '', '', '']
    )
    const answers = holdBalances(background)
    await waitFor(() => expect(answers).toHaveLength(1))

    onTestnet(store)
    await waitFor(() => expect(answers).toHaveLength(2))

    await act(async () => {
      answers[0]!([{ address: 'bc1pwatched', totalSatoshis: 999 }])
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(result.current.items[0]?.assets.totalAmount).toBe('--')

    await act(async () => {
      answers[1]!([{ address: 'bc1pwatched', totalSatoshis: 250000 }])
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(result.current.items[0]).toMatchObject({
      address: 'bc1pwatched',
      assets: OTHER_FUNDS,
    })
  })

  it("an HD wallet: reads its addresses again, and shows the other network's", async () => {
    const { result, background, store } = renderScreenFor(
      {
        type: KeyringType.HdKeyring,
        addressType: AddressType.P2TR,
        chainType: ChainType.QBIT_MAINNET,
      },
      ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']
    )
    await waitFor(() => expect(result.current.items[0]?.assets).toEqual(EMPTY))
    expect(result.current.items.every(item => item.address.startsWith('m'))).toBe(true)
    background.getAllAddresses.mockResolvedValue(['t0', 't1', 't2', 't3', 't4', 't5'])

    onTestnet(store)

    await waitFor(() => expect(background.getAllAddresses).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.items[0]?.address).toBe('t1'))
    expect(result.current.items.map(item => [item.value, item.address])).toEqual([
      [AddressType.P2WPKH, 't1'],
      [AddressType.P2SH_P2WPKH, 't3'],
      [AddressType.P2TR, 't2'],
      [AddressType.P2PKH, 't0'],
    ])
    await waitFor(() =>
      expect(result.current.items.every(item => item.assets.totalAmount !== '--')).toBe(true)
    )
    expect(background.getMultiAddressSummaries).toHaveBeenLastCalledWith('t0,t1,t2,t3,t4,t5')
  })
})

// A tap on another type asks the background to change the wallet's type. A
// refusal, which reaches the page as a plain `{ message }` object, is shown
// as one: the accounts are not read again, nothing says the type changed and
// the screen stays open.
describe('useAddressTypeScreenLogic: changing the type', () => {
  function renderHdWallet() {
    const view = renderScreenFor({ type: KeyringType.HdKeyring, addressType: AddressType.P2TR }, [
      'h0',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
    ])
    const { store } = view
    const background = Object.assign(view.background, {
      changeAddressType: vi.fn().mockResolvedValue(undefined),
      // What useReloadAccounts reads.
      getKeyrings: vi.fn(() => Promise.resolve([store.getState().keyrings.current])),
      getCurrentKeyring: vi.fn(() => Promise.resolve(store.getState().keyrings.current)),
      getAccounts: vi.fn(() => Promise.resolve([store.getState().accounts.current])),
      getCurrentAccount: vi.fn(() => Promise.resolve(store.getState().accounts.current)),
      getWalletConfig: vi.fn().mockResolvedValue({}),
    })
    return { ...view, background }
  }

  async function tapNativeSegwit(result: ReturnType<typeof renderHdWallet>['result']) {
    await waitFor(() => expect(result.current.items[0]?.assets).toEqual(EMPTY))
    const item = result.current.items.find(v => v.value === AddressType.P2WPKH)!
    let tapped: Promise<void> | undefined
    await act(async () => {
      tapped = result.current.onClickItem(item)
      await tapped
    })
    return tapped!
  }

  it("shows the background's message for a refusal, and neither reloads, says it changed nor leaves the screen", async () => {
    const { result, background, tools, navigation } = renderHdWallet()
    background.changeAddressType.mockRejectedValue({ message: 'not_supported' })

    await expect(tapNativeSegwit(result)).resolves.toBeUndefined()

    expect(background.changeAddressType).toHaveBeenCalledWith(AddressType.P2WPKH)
    expect(tools.toastError).toHaveBeenCalledTimes(1)
    expect(tools.toastError).toHaveBeenCalledWith('not_supported')
    expect(background.getKeyrings).not.toHaveBeenCalled()
    expect(background.getCurrentAccount).not.toHaveBeenCalled()
    expect(tools.toastSuccess).not.toHaveBeenCalled()
    expect(navigation.navToTab).not.toHaveBeenCalled()
  })

  it.each([
    ['an object without a message', {}],
    ['no rejection value', undefined],
  ])('shows unknown_error for a refusal with %s', async (_, refusal) => {
    const { result, background, tools, navigation } = renderHdWallet()
    background.changeAddressType.mockRejectedValue(refusal)

    await expect(tapNativeSegwit(result)).resolves.toBeUndefined()

    expect(tools.toastError).toHaveBeenCalledTimes(1)
    expect(tools.toastError).toHaveBeenCalledWith('unknown_error')
    expect(background.getKeyrings).not.toHaveBeenCalled()
    expect(tools.toastSuccess).not.toHaveBeenCalled()
    expect(navigation.navToTab).not.toHaveBeenCalled()
  })

  it('changes the type, reads the accounts again, says it changed and returns to the wallet', async () => {
    const { result, background, tools, navigation } = renderHdWallet()

    await tapNativeSegwit(result)

    expect(background.changeAddressType).toHaveBeenCalledWith(AddressType.P2WPKH)
    await waitFor(() => expect(background.getWalletConfig).toHaveBeenCalledTimes(1))
    expect(background.getKeyrings).toHaveBeenCalledTimes(1)
    expect(background.getCurrentAccount).toHaveBeenCalledTimes(1)
    expect(tools.toastSuccess).toHaveBeenCalledWith('address_type_changed')
    expect(navigation.navToTab).toHaveBeenCalledTimes(1)
    expect(tools.toastError).not.toHaveBeenCalled()
  })
})
