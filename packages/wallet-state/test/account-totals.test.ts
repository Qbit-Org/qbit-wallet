import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import { KeyringType, type QbitAccountTotal, type WalletKeyring } from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'

import { resetWalletState } from '../src/actions/global'
import {
  ACCOUNT_TOTAL_ANSWER_BATCH_MS,
  ACCOUNT_TOTAL_READS_AT_ONCE,
  useAccountSwitcherTotals,
  useCurrentAccountBalanceTotal,
} from '../src/hooks/accountTotals'
import { accountActions, isSatoshiAmount, storeAccountTotals } from '../src/reducers/accounts'
import { keyringsActions } from '../src/reducers/keyrings'
import { settingsActions } from '../src/reducers/settings'
import { uiActions } from '../src/reducers/ui'
import { unhandledRejectionsDuring } from '../../../tests/support/unhandledRejections'
import { createAppTestStore, createHookTestHarness, createWalletMock } from './ui-hooks/testHelpers'

const MAINNET = ChainType.QBIT_MAINNET
const TESTNET = ChainType.QBIT_TESTNET4

const address = (wallet: number, account: number) => `qb1zwallet${wallet}account${account}`

function makeKeyring(index: number, accountCount: number, extra: Record<string, unknown> = {}) {
  return {
    key: `keyring_${index}`,
    index,
    type: KeyringType.QbitHdKeyring,
    addressType: AddressType.P2TR,
    accounts: Array.from({ length: accountCount }, (_, i) => ({
      type: KeyringType.QbitHdKeyring,
      address: address(index, i),
      brandName: 'Qbit',
      alianName: `Account ${i + 1}`,
      displayBrandName: 'Qbit',
      index: i,
      balance: 0,
      pubkey: `pubkey-${index}-${i}`,
      key: `keyring_${index}#${i}`,
      flag: 0,
    })),
    alianName: `Wallet ${index + 1}`,
    color: 'green',
    hdPath: '',
    ...extra,
  } as WalletKeyring
}

const total = (
  addr: string,
  totalBalance: number | null,
  extra: Partial<QbitAccountTotal> = {}
): QbitAccountTotal => ({
  address: addr,
  chainType: MAINNET,
  totalBalance,
  readAt: totalBalance === null ? null : 1_700_000_000_000,
  fresh: false,
  error: false,
  ...extra,
})

/** A read's answer: its total is fresh, as after a read that measured it. */
const readAnswer = (
  addr: string,
  totalBalance: number | null,
  extra: Partial<QbitAccountTotal> = {}
): QbitAccountTotal => total(addr, totalBalance, { fresh: totalBalance !== null, ...extra })

const view = (totalBalance: number | null, stale = false, pending = false) => ({
  totalBalance,
  stale,
  pending,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Lets every answer already given reach the store and the hook: the
 * microtasks, and the batch time, a few times over, as kept totals lead to
 * reads.
 */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(ACCOUNT_TOTAL_ANSWER_BATCH_MS)
    }
  })
}

/** The microtasks only: answers given so far wait for the batch time. */
async function flushMicrotasks() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  })
}

/**
 * A page with `keyrings` listed, the first one current unless said, and a
 * background whose two total methods are spies the test answers. `renders`
 * counts the hook's renders.
 */
function setup(keyrings: WalletKeyring[], { current = 0 } = {}) {
  const store = createAppTestStore()
  store.dispatch(keyringsActions.setKeyrings(keyrings))
  store.dispatch(keyringsActions.setCurrent(keyrings[current]))
  const wallet = {
    ...createWalletMock(),
    getQbitAccountTotals: vi.fn(async (addresses: string[]) =>
      addresses.map(addr => total(addr, null))
    ),
    readQbitAccountTotal: vi.fn(async (addr: string) => readAnswer(addr, 0)),
  }
  const harness = { renders: 0 }
  const { wrapper } = createHookTestHarness({ wallet: wallet as any, store })
  const open = (list: WalletKeyring[] = keyrings) =>
    renderHook(
      ({ wallets }) => {
        harness.renders += 1
        return useAccountSwitcherTotals(wallets)
      },
      { wrapper, initialProps: { wallets: list } }
    )
  const storedTotal = (addr: string, chainType: ChainType = MAINNET) =>
    store.getState().accounts.accountTotalsMap[chainType]?.[addr]
  const dispatchSpy = vi.spyOn(store, 'dispatch')
  const storeDispatches = () =>
    dispatchSpy.mock.calls.filter(([action]) => action.type === storeAccountTotals.type).length
  return { store, wallet, open, harness, storedTotal, storeDispatches }
}

/** Stores a total for `addr` as an earlier opening left it. */
function storeEarlierTotal(
  store: ReturnType<typeof createAppTestStore>,
  addr: string,
  totalBalance: number
) {
  store.dispatch(
    storeAccountTotals([
      {
        address: addr,
        chainType: MAINNET,
        requestId: 1,
        totalBalance,
        readAt: 1,
        stale: false,
        settled: true,
      },
    ])
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('useAccountSwitcherTotals', () => {
  it('asks once for the kept totals, the current wallet first, and shows them at once', async () => {
    const keyrings = [makeKeyring(0, 2), makeKeyring(1, 1), makeKeyring(2, 1)]
    const { wallet, open } = setup(keyrings, { current: 1 })
    const reads = deferred<QbitAccountTotal>()
    wallet.readQbitAccountTotal.mockImplementation(() => reads.promise)
    wallet.getQbitAccountTotals.mockResolvedValueOnce([
      total(address(1, 0), 700, { fresh: true }),
      total(address(0, 0), 100),
      total(address(0, 1), null),
      total(address(2, 0), 300, { fresh: true }),
    ])

    const { result } = open()
    // Before any answer: every account is pending, none has a total.
    expect(result.current.hidden).toBe(false)
    expect(result.current.totals[address(0, 0)]).toEqual(view(null, false, true))
    await settle()

    expect(wallet.getQbitAccountTotals).toHaveBeenCalledTimes(1)
    expect(wallet.getQbitAccountTotals).toHaveBeenCalledWith([
      address(1, 0),
      address(0, 0),
      address(0, 1),
      address(2, 0),
    ])
    // The kept totals show while the reads are still out.
    expect({ ...result.current.totals }).toEqual({
      [address(1, 0)]: view(700),
      [address(0, 0)]: view(100, false, true),
      [address(0, 1)]: view(null, false, true),
      [address(2, 0)]: view(300),
    })
    // Only the totals that are not fresh are read, each on its own.
    expect(wallet.readQbitAccountTotal.mock.calls).toEqual([[address(0, 0)], [address(0, 1)]])
  })

  it('shows each read as it arrives, and a failed read as stale or unknown', async () => {
    const keyrings = [makeKeyring(0, 3)]
    const { wallet, open } = setup(keyrings)
    wallet.getQbitAccountTotals.mockResolvedValueOnce([
      total(address(0, 0), 100),
      total(address(0, 1), 200, { error: true }),
      total(address(0, 2), null),
    ])
    const answers = new Map<string, ReturnType<typeof deferred<QbitAccountTotal>>>()
    wallet.readQbitAccountTotal.mockImplementation((addr: string) => {
      const answer = deferred<QbitAccountTotal>()
      answers.set(addr, answer)
      return answer.promise
    })

    const { result } = open()
    await settle()
    // A kept total whose last read failed shows as stale until read again.
    expect(result.current.totals[address(0, 1)]).toEqual(view(200, true, true))

    answers.get(address(0, 2))!.resolve(total(address(0, 2), null, { error: true }))
    await settle()
    expect(result.current.totals[address(0, 2)]).toEqual(view(null))
    expect(result.current.totals[address(0, 0)]!.pending).toBe(true)

    answers.get(address(0, 0))!.resolve(readAnswer(address(0, 0), 150))
    // Over the port a rejection is a plain object.
    answers.get(address(0, 1))!.reject({ message: 'explorer down', stack: '' })
    await settle()
    expect(result.current.totals[address(0, 0)]).toEqual(view(150))
    expect(result.current.totals[address(0, 1)]).toEqual(view(200, true))
  })

  it('marks a total that was current as stale when its read is rejected', async () => {
    const { wallet, open } = setup([makeKeyring(0, 1)])
    wallet.getQbitAccountTotals.mockResolvedValueOnce([total(address(0, 0), 100)])
    wallet.readQbitAccountTotal.mockRejectedValueOnce({ message: 'timed out', stack: '' })

    const { result } = open()
    await settle()

    expect(result.current.totals[address(0, 0)]).toEqual(view(100, true))
  })

  it('keeps an earlier total as stale when a read answers none without an error', async () => {
    // The answer of a locked wallet, or of an address the background does
    // not list: it measures nothing, and vouches for nothing either.
    const { wallet, open } = setup([makeKeyring(0, 1)])
    wallet.getQbitAccountTotals.mockResolvedValueOnce([total(address(0, 0), 100)])
    wallet.readQbitAccountTotal.mockResolvedValueOnce(total(address(0, 0), null))

    const { result } = open()
    await settle()

    expect(result.current.totals[address(0, 0)]).toEqual(view(100, true))
  })

  it('shows a read total that may be from before a submission as stale, not as current', async () => {
    // The background answers a read that began before a transaction the
    // wallet submitted, or settled while it was in flight, as not fresh,
    // without an error.
    const { wallet, open, storedTotal } = setup([makeKeyring(0, 2)])
    wallet.getQbitAccountTotals.mockResolvedValueOnce([
      total(address(0, 0), 100),
      total(address(0, 1), 200),
    ])
    wallet.readQbitAccountTotal.mockImplementation(async (addr: string) =>
      addr === address(0, 0)
        ? total(addr, 150, { fresh: false, error: false })
        : readAnswer(addr, 250)
    )

    const { result } = open()
    await settle()

    expect(wallet.readQbitAccountTotal).toHaveBeenCalledTimes(2)
    expect(result.current.totals[address(0, 0)]).toEqual(view(150, true))
    expect(storedTotal(address(0, 0))).toMatchObject({ totalBalance: 150, stale: true })
    expect(result.current.totals[address(0, 1)]).toEqual(view(250))
  })

  it('keeps a stale total stale through a kept answer that is not fresh, until a read says otherwise', async () => {
    const keyrings = [makeKeyring(0, 3)]
    const [a0, a1, a2] = keyrings[0]!.accounts.map(item => item.address)
    const { store, wallet, open, storedTotal } = setup(keyrings)
    // An earlier opening: a0's read said its total may be from before a
    // submission, a1's read failed, a2's was current.
    storeEarlierTotal(store, a2, 300)
    wallet.getQbitAccountTotals.mockResolvedValueOnce([
      total(a0, null),
      total(a1, 200),
      total(a2, 300, { fresh: true }),
    ])
    wallet.readQbitAccountTotal
      .mockResolvedValueOnce(total(a0!, 100, { fresh: false, error: false }))
      .mockRejectedValueOnce({ message: 'timed out', stack: '' })
    const first = open()
    await settle()
    expect(first.result.current.totals[a0!]).toEqual(view(100, true))
    expect(first.result.current.totals[a1!]).toEqual(view(200, true))
    expect(first.result.current.totals[a2!]).toEqual(view(300))
    first.unmount()

    // Opened again: the kept totals are not fresh, without an error, and
    // the reads are on their way.
    const reads = new Map<string, ReturnType<typeof deferred<QbitAccountTotal>>>()
    wallet.readQbitAccountTotal.mockImplementation((addr: string) => {
      const read = deferred<QbitAccountTotal>()
      reads.set(addr, read)
      return read.promise
    })
    wallet.getQbitAccountTotals.mockResolvedValueOnce([
      total(a0!, 110),
      total(a1!, 210),
      total(a2!, 310),
    ])
    const { result } = open()
    await settle()
    expect(reads.size).toBe(3)
    expect(result.current.totals[a0!]).toEqual(view(110, true, true))
    expect(result.current.totals[a1!]).toEqual(view(210, true, true))
    expect(storedTotal(a1!)).toMatchObject({ totalBalance: 210, stale: true, settled: false })
    // A total with no stale mark shows as before while its read is out.
    expect(result.current.totals[a2!]).toEqual(view(310, false, true))

    // A read's answer that is fresh clears the mark.
    reads.get(a0!)!.resolve(readAnswer(a0!, 120))
    await settle()
    expect(result.current.totals[a0!]).toEqual(view(120))
    expect(result.current.totals[a1!]).toEqual(view(210, true, true))
  })

  it('stores no kept answer without a total, so an earlier total stays current until read', async () => {
    // A background that restarted keeps nothing: its kept answers carry no
    // total, which says nothing about the total the page showed before.
    const { store, wallet, open, storedTotal } = setup([makeKeyring(0, 1)])
    storeEarlierTotal(store, address(0, 0), 500)
    wallet.readQbitAccountTotal.mockImplementation(() => new Promise(() => undefined))

    const { result } = open()
    await settle()

    expect(wallet.readQbitAccountTotal).toHaveBeenCalledTimes(1)
    expect(result.current.totals[address(0, 0)]).toEqual(view(500, false, true))
    expect(storedTotal(address(0, 0))).toMatchObject({ totalBalance: 500, stale: false })
  })

  it('reads every account when the kept totals are refused', async () => {
    const keyrings = [makeKeyring(0, 2), makeKeyring(1, 1)]
    const { wallet, open } = setup(keyrings)
    wallet.getQbitAccountTotals.mockRejectedValueOnce({
      message: 'Unknown wallet method: getQbitAccountTotals',
      stack: '',
    })
    wallet.readQbitAccountTotal.mockImplementation(async (addr: string) => readAnswer(addr, 42))

    const { result } = open()
    await settle()

    expect(wallet.readQbitAccountTotal.mock.calls).toEqual([
      [address(0, 0)],
      [address(0, 1)],
      [address(1, 0)],
    ])
    for (const addr of [address(0, 0), address(0, 1), address(1, 0)]) {
      expect(result.current.totals[addr]).toEqual(view(42))
    }
  })

  it('reads an account whose kept answer is missing or malformed', async () => {
    const keyrings = [makeKeyring(0, 5)]
    const { wallet, open } = setup(keyrings)
    wallet.getQbitAccountTotals.mockResolvedValueOnce([
      // Another address in its place, a total that is no number of sats, a
      // fresh answer with no total, and a network the wallet does not have:
      // none of them is a usable answer.
      total(address(0, 3), 1, { fresh: true }),
      total(address(0, 1), 1.5 as number, { fresh: true }),
      total(address(0, 2), null, { fresh: true }),
      total(address(0, 3), 7, { fresh: true, chainType: 'QBIT_NOWHERE' as ChainType }),
    ] as QbitAccountTotal[])

    const { result } = open()
    await settle()

    expect(wallet.readQbitAccountTotal.mock.calls.map(([addr]) => addr)).toEqual([
      address(0, 0),
      address(0, 1),
      address(0, 2),
      address(0, 3),
      address(0, 4),
    ])
    expect(result.current.totals[address(0, 1)]!.totalBalance).toBe(0)
  })

  it('reads the accounts of an answer naming a built-in as its network, writing nothing to a built-in', async () => {
    const names = ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf']
    const keyrings = [makeKeyring(0, names.length + 1)]
    const { store, wallet, open } = setup(keyrings)
    const addresses = keyrings[0]!.accounts.map(account => account.address)
    // Plain functions, not spies: a spy marks the promises it returns as
    // handled, which would hide a rejection nothing handles.
    const kept = async (batch: string[]) => [
      ...names.map((chainType, index) =>
        total(batch[index]!, 5, { chainType: chainType as ChainType, fresh: true })
      ),
      total(batch[names.length]!, 6, { fresh: true }),
    ]
    ;(wallet as any).getQbitAccountTotals = kept
    const reads: string[] = []
    ;(wallet as any).readQbitAccountTotal = async (addr: string) => {
      reads.push(addr)
      return readAnswer(addr, 9)
    }

    let result!: ReturnType<ReturnType<typeof setup>['open']>['result']
    const rejections = await unhandledRejectionsDuring(async () => {
      result = open().result
      await settle()
    })

    expect(rejections).toEqual([])
    expect(reads).toEqual(addresses.slice(0, names.length))
    for (const addr of addresses.slice(0, names.length)) {
      expect(result.current.totals[addr]).toEqual(view(9))
    }
    expect(result.current.totals[addresses[names.length]!]).toEqual(view(6))
    expect(Object.keys(store.getState().accounts.accountTotalsMap)).toEqual([MAINNET])
    for (const addr of addresses) {
      expect((Object as any)[addr]).toBeUndefined()
      expect((Object.prototype as any)[addr]).toBeUndefined()
      expect((Object.prototype.hasOwnProperty as any)[addr]).toBeUndefined()
    }
  })

  it('keeps an address that names a built-in as its own key', async () => {
    const names = ['__proto__', 'constructor', 'hasOwnProperty']
    const keyring = makeKeyring(0, 0)
    keyring.accounts = names.map((name, index) => ({
      ...makeKeyring(0, 1).accounts[0]!,
      address: name,
      key: `keyring_0#${index}`,
    }))
    const { store, wallet, open } = setup([keyring])
    wallet.readQbitAccountTotal.mockImplementation(async (addr: string) => readAnswer(addr, 11))

    const { result } = open()
    await settle()

    const stored = store.getState().accounts.accountTotalsMap[MAINNET]!
    expect(Object.keys(stored).sort()).toEqual([...names].sort())
    for (const name of names) {
      expect(Object.prototype.hasOwnProperty.call(stored, name)).toBe(true)
      expect(result.current.totals[name]).toEqual(view(11))
    }
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
  })

  it('settles every row when the store refuses the answers, with no error left unhandled', async () => {
    const keyrings = [makeKeyring(0, 2)]
    const { store, wallet } = setup(keyrings)
    wallet.getQbitAccountTotals.mockResolvedValueOnce([
      total(address(0, 0), 100, { fresh: true }),
      total(address(0, 1), null),
    ])
    // A read whose answer throws as it is looked at.
    wallet.readQbitAccountTotal.mockResolvedValueOnce({
      get address(): string {
        throw new Error('unreadable')
      },
    } as unknown as QbitAccountTotal)
    const refusing = {
      ...store,
      dispatch: (action: { type: string }) => {
        if (action.type === storeAccountTotals.type) throw new Error('refused')
        return store.dispatch(action as never)
      },
    }
    const { wrapper } = createHookTestHarness({ wallet: wallet as any, store: refusing as any })

    let result!: { current: ReturnType<typeof useAccountSwitcherTotals> }
    const rejections = await unhandledRejectionsDuring(async () => {
      result = renderHook(() => useAccountSwitcherTotals(keyrings), { wrapper }).result
      await settle()
    })

    expect(rejections).toEqual([])
    expect(result.current.totals[address(0, 0)]).toEqual(view(null))
    expect(result.current.totals[address(0, 1)]).toEqual(view(null))
  })

  it('asks each account once per opening, and only the new ones when the list changes', async () => {
    const keyrings = [makeKeyring(0, 1), makeKeyring(1, 1)]
    const { wallet, open } = setup(keyrings)

    const { rerender } = open()
    await settle()
    expect(wallet.getQbitAccountTotals).toHaveBeenCalledTimes(1)
    expect(wallet.readQbitAccountTotal).toHaveBeenCalledTimes(2)

    // The list read again: the same accounts, a new array.
    rerender({ wallets: keyrings.map(keyring => ({ ...keyring })) })
    await settle()
    // A wallet removed.
    rerender({ wallets: [keyrings[0]!] })
    await settle()
    expect(wallet.getQbitAccountTotals).toHaveBeenCalledTimes(1)
    expect(wallet.readQbitAccountTotal).toHaveBeenCalledTimes(2)

    // An account added: only its address is asked about.
    const grown = [makeKeyring(0, 2), keyrings[1]!]
    rerender({ wallets: grown })
    await settle()
    expect(wallet.getQbitAccountTotals).toHaveBeenCalledTimes(2)
    expect(wallet.getQbitAccountTotals).toHaveBeenLastCalledWith([address(0, 1)])
    expect(wallet.readQbitAccountTotal).toHaveBeenCalledTimes(3)
    expect(wallet.readQbitAccountTotal).toHaveBeenLastCalledWith(address(0, 1))
  })

  it('asks nothing for a corrupted wallet', async () => {
    const keyrings = [makeKeyring(0, 1), makeKeyring(1, 1, { isCorrupted: true })]
    const { wallet, open } = setup(keyrings)

    const { result } = open()
    await settle()

    expect(wallet.getQbitAccountTotals).toHaveBeenCalledWith([address(0, 0)])
    expect(result.current.totals[address(1, 0)]).toBeUndefined()
  })

  it('splits the kept-totals request at the background limit of 1,024 addresses', async () => {
    const keyrings = [makeKeyring(0, 1025)]
    const { wallet, open } = setup(keyrings)
    wallet.readQbitAccountTotal.mockImplementation(() => new Promise(() => undefined))

    open()
    await settle()

    expect(wallet.getQbitAccountTotals.mock.calls.map(([batch]) => batch.length)).toEqual([1024, 1])
  })

  it('asks nothing while balances are hidden', async () => {
    const keyrings = [makeKeyring(0, 2)]
    const { store, wallet, open } = setup(keyrings)
    store.dispatch(uiActions.setBalanceHidden(true))

    const { result, rerender } = open()
    await settle()
    rerender({ wallets: [makeKeyring(0, 3)] })
    await settle()

    expect(wallet.getQbitAccountTotals).not.toHaveBeenCalled()
    expect(wallet.readQbitAccountTotal).not.toHaveBeenCalled()
    expect(result.current.hidden).toBe(true)
    expect(result.current.totals[address(0, 0)]).toEqual(view(null))
  })

  it('starts no read once balances are hidden while the kept totals are out, and reads when shown', async () => {
    const keyrings = [makeKeyring(0, 2)]
    const { store, wallet, open } = setup(keyrings)
    const kept = deferred<QbitAccountTotal[]>()
    wallet.getQbitAccountTotals.mockImplementationOnce(() => kept.promise)

    const { result } = open()
    await settle()
    act(() => {
      store.dispatch(uiActions.setBalanceHidden(true))
    })
    kept.resolve([total(address(0, 0), 1), total(address(0, 1), null)])
    await settle()
    expect(wallet.readQbitAccountTotal).not.toHaveBeenCalled()
    expect(result.current.totals[address(0, 0)]).toEqual(view(1))

    // Shown again with the sheet open: the accounts left unread are asked
    // about once more.
    act(() => {
      store.dispatch(uiActions.setBalanceHidden(false))
    })
    await settle()
    expect(wallet.getQbitAccountTotals).toHaveBeenCalledTimes(2)
    expect(wallet.readQbitAccountTotal.mock.calls).toEqual([[address(0, 0)], [address(0, 1)]])
  })

  it('never lets the answer of an older request replace a newer one', async () => {
    const keyrings = [makeKeyring(0, 1)]
    const { wallet, open, storedTotal } = setup(keyrings)
    const first = deferred<QbitAccountTotal>()
    const second = deferred<QbitAccountTotal>()
    wallet.readQbitAccountTotal
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)

    // The first opening's read is still out when the sheet closes.
    const firstOpening = open()
    await settle()
    firstOpening.unmount()
    const { result } = open()
    await settle()
    expect(wallet.readQbitAccountTotal).toHaveBeenCalledTimes(2)

    // The newer read answers first, the older one after it.
    second.resolve(readAnswer(address(0, 0), 500))
    await settle()
    first.resolve(readAnswer(address(0, 0), 300))
    await settle()
    expect(result.current.totals[address(0, 0)]!.totalBalance).toBe(500)
    expect(storedTotal(address(0, 0))!.totalBalance).toBe(500)

    // An older failure does not mark the newer total stale either.
    const third = deferred<QbitAccountTotal>()
    const fourth = deferred<QbitAccountTotal>()
    wallet.readQbitAccountTotal
      .mockImplementationOnce(() => third.promise)
      .mockImplementationOnce(() => fourth.promise)
    const secondOpening = open()
    await settle()
    secondOpening.unmount()
    const reopened = open()
    await settle()
    fourth.resolve(readAnswer(address(0, 0), 900))
    await settle()
    third.reject({ message: 'timed out', stack: '' })
    await settle()
    expect(reopened.result.current.totals[address(0, 0)]).toEqual(view(900))
  })

  it('takes an answer for another network as no answer for this one', async () => {
    const keyrings = [makeKeyring(0, 2)]
    const { store, wallet, open, storedTotal } = setup(keyrings)
    // An earlier total on this network, which the answers cannot vouch for.
    storeEarlierTotal(store, address(0, 0), 500)
    wallet.getQbitAccountTotals.mockResolvedValueOnce([
      total(address(0, 0), 100, { chainType: TESTNET, fresh: true }),
      total(address(0, 1), null),
    ])
    wallet.readQbitAccountTotal.mockImplementation(async (addr: string) =>
      readAnswer(addr, 777, { chainType: TESTNET })
    )

    const { result } = open()
    await settle()

    // A fresh kept total for another network leaves the account to its read.
    expect(wallet.readQbitAccountTotal).toHaveBeenCalledWith(address(0, 0))
    expect(result.current.totals[address(0, 0)]).toEqual(view(500, true))
    expect(result.current.totals[address(0, 1)]).toEqual(view(null))
    // Stored under its own network, it shows once that network is current,
    // where the accounts are asked about again.
    expect(storedTotal(address(0, 1), TESTNET)!.totalBalance).toBe(777)
    const asked = wallet.getQbitAccountTotals.mock.calls.length
    act(() => {
      store.dispatch(settingsActions.updateSettings({ chainType: TESTNET }))
    })
    expect(result.current.totals[address(0, 1)]).toEqual(view(777, false, true))
    await settle()
    expect(wallet.getQbitAccountTotals.mock.calls.length).toBe(asked + 1)
    expect(result.current.totals[address(0, 1)]).toEqual(view(777))
  })

  it('asks again on a network it comes back to while open', async () => {
    const keyrings = [makeKeyring(0, 1)]
    const { store, wallet, open } = setup(keyrings)
    // The background is on testnet while this page still says mainnet.
    wallet.getQbitAccountTotals.mockImplementation(async (addresses: string[]) =>
      addresses.map(addr => total(addr, 10, { chainType: TESTNET, fresh: true }))
    )
    wallet.readQbitAccountTotal.mockImplementation(async (addr: string) =>
      readAnswer(addr, 10, { chainType: TESTNET })
    )
    const { result } = open()
    await settle()
    expect(result.current.totals[address(0, 0)]).toEqual(view(null))

    act(() => {
      store.dispatch(settingsActions.updateSettings({ chainType: TESTNET }))
    })
    await settle()
    expect(result.current.totals[address(0, 0)]).toEqual(view(10))

    // Back on mainnet, which the background now answers for.
    wallet.getQbitAccountTotals.mockImplementation(async (addresses: string[]) =>
      addresses.map(addr => total(addr, 20, { fresh: true }))
    )
    const calls = wallet.getQbitAccountTotals.mock.calls.length
    act(() => {
      store.dispatch(settingsActions.updateSettings({ chainType: MAINNET }))
    })
    expect(result.current.totals[address(0, 0)]!.pending).toBe(true)
    await settle()
    expect(wallet.getQbitAccountTotals.mock.calls.length).toBe(calls + 1)
    expect(result.current.totals[address(0, 0)]).toEqual(view(20))
  })

  it('shows on opening again what it showed before, while the background is asked again', async () => {
    const keyrings = [makeKeyring(0, 1)]
    const { wallet, open } = setup(keyrings)
    wallet.readQbitAccountTotal.mockResolvedValueOnce(readAnswer(address(0, 0), 1250))

    const first = open()
    await settle()
    expect(first.result.current.totals[address(0, 0)]).toEqual(view(1250))
    first.unmount()

    wallet.getQbitAccountTotals.mockImplementationOnce(() => new Promise(() => undefined))
    const { result } = open()
    // On the first render, before any answer: the total shown before.
    expect(result.current.totals[address(0, 0)]).toEqual(view(1250, false, true))
    expect(wallet.getQbitAccountTotals).toHaveBeenCalledTimes(2)
  })

  it('stores answers that arrive close together in one update, one render each', async () => {
    const accountCount = 20
    const keyrings = [makeKeyring(0, accountCount)]
    const { wallet, open, harness, storeDispatches } = setup(keyrings)
    const reads: Array<ReturnType<typeof deferred<QbitAccountTotal>>> = []
    wallet.readQbitAccountTotal.mockImplementation(() => {
      const read = deferred<QbitAccountTotal>()
      reads.push(read)
      return read.promise
    })

    const { result } = open()
    await settle()
    expect(reads).toHaveLength(ACCOUNT_TOTAL_READS_AT_ONCE)
    const dispatchesBefore = storeDispatches()
    const rendersBefore = harness.renders

    // Every read answers within the batch time, the waiting ones sent as
    // those before them settle.
    let answered = 0
    while (answered < accountCount) {
      const out = reads.slice(answered)
      expect(out.length).toBeGreaterThan(0)
      out.forEach((read, index) =>
        read.resolve(readAnswer(address(0, answered + index), answered + index))
      )
      answered += out.length
      await flushMicrotasks()
    }
    expect(reads).toHaveLength(accountCount)
    expect(harness.renders).toBe(rendersBefore)
    await settle()

    expect(storeDispatches()).toBe(dispatchesBefore + 1)
    expect(harness.renders).toBe(rendersBefore + 1)
    expect(result.current.totals[address(0, 7)]).toEqual(view(7))
  })

  it('stores an answer apart from one that comes after the batch time, one render each', async () => {
    const keyrings = [makeKeyring(0, 2)]
    const { wallet, open, harness, storeDispatches } = setup(keyrings)
    const reads: Array<ReturnType<typeof deferred<QbitAccountTotal>>> = []
    wallet.readQbitAccountTotal.mockImplementation(() => {
      const read = deferred<QbitAccountTotal>()
      reads.push(read)
      return read.promise
    })
    const { result } = open()
    await settle()
    const dispatchesBefore = storeDispatches()
    const rendersBefore = harness.renders

    reads[0]!.resolve(readAnswer(address(0, 0), 1))
    await settle()
    expect(result.current.totals[address(0, 0)]).toEqual(view(1))
    expect(result.current.totals[address(0, 1)]!.pending).toBe(true)
    reads[1]!.resolve(readAnswer(address(0, 1), 2))
    await settle()

    expect(storeDispatches()).toBe(dispatchesBefore + 2)
    expect(harness.renders).toBe(rendersBefore + 2)
  })

  it('stores the answers still waiting when the sheet closes, and later ones, without a warning', async () => {
    const keyrings = [makeKeyring(0, 2)]
    const { wallet, open, storedTotal } = setup(keyrings)
    const reads: Array<ReturnType<typeof deferred<QbitAccountTotal>>> = []
    wallet.readQbitAccountTotal.mockImplementation(() => {
      const read = deferred<QbitAccountTotal>()
      reads.push(read)
      return read.promise
    })
    const errors = vi.spyOn(console, 'error')
    const warnings = vi.spyOn(console, 'warn')

    const sheet = open()
    await settle()
    reads[0]!.resolve(readAnswer(address(0, 0), 64))
    await flushMicrotasks()
    // Closed within the batch time: what waits is stored at once.
    sheet.unmount()
    expect(storedTotal(address(0, 0))!.totalBalance).toBe(64)

    reads[1]!.resolve(readAnswer(address(0, 1), 65))
    await settle()
    expect(storedTotal(address(0, 1))!.totalBalance).toBe(65)
    expect(errors).not.toHaveBeenCalled()
    expect(warnings).not.toHaveBeenCalled()
  })

  it('reads nothing once the sheet closed before the kept totals answered', async () => {
    const keyrings = [makeKeyring(0, 1)]
    const { wallet, open, storedTotal } = setup(keyrings)
    const kept = deferred<QbitAccountTotal[]>()
    wallet.getQbitAccountTotals.mockImplementationOnce(() => kept.promise)

    open().unmount()
    kept.resolve([total(address(0, 0), 64)])
    await settle()

    expect(storedTotal(address(0, 0))!.totalBalance).toBe(64)
    expect(wallet.readQbitAccountTotal).not.toHaveBeenCalled()
  })

  it('has at most 4 reads out at once, as the background reads from an explorer, sending the next as one settles, in order', async () => {
    const keyrings = [makeKeyring(0, 5), makeKeyring(1, 15)]
    const { wallet, open } = setup(keyrings, { current: 1 })
    const order = [...keyrings[1]!.accounts, ...keyrings[0]!.accounts].map(item => item.address)
    const out = new Map<string, ReturnType<typeof deferred<QbitAccountTotal>>>()
    let mostOut = 0
    wallet.readQbitAccountTotal.mockImplementation((addr: string) => {
      const read = deferred<QbitAccountTotal>()
      out.set(addr, read)
      mostOut = Math.max(mostOut, out.size)
      return read.promise
    })
    const answer = (addr: string) => {
      out.get(addr)!.resolve(readAnswer(addr, order.indexOf(addr) + 1))
      out.delete(addr)
    }
    const sent = () => wallet.readQbitAccountTotal.mock.calls.map(([addr]) => addr)

    const { result } = open()
    await settle()
    expect(ACCOUNT_TOTAL_READS_AT_ONCE).toBe(4)
    expect(sent()).toEqual(order.slice(0, 4))

    // One settles, whichever it is: one more goes, the next in order.
    answer(order[2]!)
    await settle()
    expect(sent()).toEqual(order.slice(0, 5))

    // With the sheet open, every account is read.
    while (out.size > 0) {
      for (const addr of [...out.keys()]) answer(addr)
      await settle()
    }
    expect(sent()).toEqual(order)
    expect(mostOut).toBe(4)
    order.forEach((addr, index) => expect(result.current.totals[addr]).toEqual(view(index + 1)))
  })

  it('sends none of the reads still waiting once the sheet closes', async () => {
    const keyrings = [makeKeyring(0, 20)]
    const { wallet, open, storedTotal } = setup(keyrings)
    const reads: Array<ReturnType<typeof deferred<QbitAccountTotal>>> = []
    wallet.readQbitAccountTotal.mockImplementation(() => {
      const read = deferred<QbitAccountTotal>()
      reads.push(read)
      return read.promise
    })

    const sheet = open()
    await settle()
    expect(reads).toHaveLength(ACCOUNT_TOTAL_READS_AT_ONCE)
    sheet.unmount()
    reads.forEach((read, index) => read.resolve(readAnswer(address(0, index), index + 1)))
    await settle()

    expect(wallet.readQbitAccountTotal).toHaveBeenCalledTimes(ACCOUNT_TOTAL_READS_AT_ONCE)
    // What the reads that were out answered is stored all the same.
    expect(storedTotal(address(0, ACCOUNT_TOTAL_READS_AT_ONCE - 1))!.totalBalance).toBe(
      ACCOUNT_TOTAL_READS_AT_ONCE
    )
  })

  it('sends no waiting read while balances are hidden, and asks about those accounts again once shown', async () => {
    const accountCount = ACCOUNT_TOTAL_READS_AT_ONCE + 2
    const keyrings = [makeKeyring(0, accountCount)]
    const { store, wallet, open } = setup(keyrings)
    const reads: Array<ReturnType<typeof deferred<QbitAccountTotal>>> = []
    wallet.readQbitAccountTotal.mockImplementation(() => {
      const read = deferred<QbitAccountTotal>()
      reads.push(read)
      return read.promise
    })
    const sent = () => wallet.readQbitAccountTotal.mock.calls.map(([addr]) => addr)
    const first = Array.from({ length: ACCOUNT_TOTAL_READS_AT_ONCE }, (_, i) => address(0, i))
    const rest = [address(0, accountCount - 2), address(0, accountCount - 1)]

    const { result } = open()
    await settle()
    expect(sent()).toEqual(first)
    act(() => {
      store.dispatch(uiActions.setBalanceHidden(true))
    })
    reads.forEach((read, index) => read.resolve(readAnswer(address(0, index), index + 1)))
    await settle()
    expect(sent()).toEqual(first)
    expect(wallet.getQbitAccountTotals).toHaveBeenCalledTimes(1)

    act(() => {
      store.dispatch(uiActions.setBalanceHidden(false))
    })
    expect(result.current.totals[rest[0]!]!.pending).toBe(true)
    await settle()
    expect(wallet.getQbitAccountTotals).toHaveBeenCalledTimes(2)
    expect(wallet.getQbitAccountTotals).toHaveBeenLastCalledWith(rest)
    expect(sent()).toEqual([...first, ...rest])
  })

  it('sends no waiting read of a network the page has left', async () => {
    const accountCount = ACCOUNT_TOTAL_READS_AT_ONCE + 2
    const keyrings = [makeKeyring(0, accountCount)]
    const { store, wallet, open } = setup(keyrings)
    const reads: Array<ReturnType<typeof deferred<QbitAccountTotal>>> = []
    wallet.readQbitAccountTotal.mockImplementation(() => {
      const read = deferred<QbitAccountTotal>()
      reads.push(read)
      return read.promise
    })
    const sent = () => wallet.readQbitAccountTotal.mock.calls.map(([addr]) => addr)
    const first = Array.from({ length: ACCOUNT_TOTAL_READS_AT_ONCE }, (_, i) => address(0, i))

    open()
    await settle()
    act(() => {
      store.dispatch(settingsActions.updateSettings({ chainType: TESTNET }))
    })
    await settle()
    expect(sent()).toEqual(first)

    // The mainnet reads settle: the two still waiting for mainnet are
    // dropped, and testnet's go out in their place.
    reads.forEach((read, index) => read.resolve(readAnswer(address(0, index), 1)))
    await settle()
    expect(sent()).toEqual([...first, ...first])
  })

  it.each([
    ['resetWalletState', () => resetWalletState()],
    ['accounts/reset', () => accountActions.reset(undefined)],
  ])('drops the answers of requests made before %s', async (_name, reset) => {
    const keyrings = [makeKeyring(0, 2)]
    const { store, wallet, open, storedTotal } = setup(keyrings)
    const kept = deferred<QbitAccountTotal[]>()
    const read = deferred<QbitAccountTotal>()
    wallet.getQbitAccountTotals
      .mockResolvedValueOnce([total(address(0, 0), 100), total(address(0, 1), null)])
      .mockImplementationOnce(() => kept.promise)
    wallet.readQbitAccountTotal
      .mockImplementationOnce(() => read.promise)
      .mockImplementationOnce(() => new Promise(() => undefined))

    const first = open()
    await settle()
    expect(storedTotal(address(0, 0))!.totalBalance).toBe(100)
    const second = open()
    await settle()

    act(() => {
      store.dispatch(reset())
    })
    expect(store.getState().accounts.accountTotalsMap).toEqual({})
    first.unmount()
    second.unmount()
    read.resolve(readAnswer(address(0, 0), 777))
    kept.resolve([total(address(0, 0), 888), total(address(0, 1), 999)])
    await settle()

    expect(store.getState().accounts.accountTotalsMap).toEqual({})

    // A request made after the reset is stored.
    wallet.getQbitAccountTotals.mockResolvedValueOnce([
      total(address(0, 0), 5, { fresh: true }),
      total(address(0, 1), 6, { fresh: true }),
    ])
    open()
    await settle()
    expect(storedTotal(address(0, 0))!.totalBalance).toBe(5)
  })

  it('writes no total to localStorage', async () => {
    const keyrings = [makeKeyring(0, 2)]
    const { store, wallet, open } = setup(keyrings)
    wallet.getQbitAccountTotals.mockResolvedValueOnce([
      total(address(0, 0), 987654321, { fresh: true }),
      total(address(0, 1), null),
    ])
    wallet.readQbitAccountTotal.mockResolvedValueOnce(readAnswer(address(0, 1), 123456789))
    open()
    await settle()
    // A preference change makes the page save, as it does after a second.
    store.dispatch(uiActions.setBalanceDetailExpanded(false))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })

    expect(Object.keys(store.getState().accounts.accountTotalsMap[MAINNET]!)).toHaveLength(2)
    const everything = Object.keys(localStorage)
      .map(key => `${key}=${localStorage.getItem(key)}`)
      .join('\n')
    expect(Object.keys(localStorage)).toEqual(['redux_localstorage_simple_ui'])
    for (const text of ['987654321', '123456789', 'qb1zwallet', 'accountTotals']) {
      expect(everything).not.toContain(text)
    }
  })
})

describe('useCurrentAccountBalanceTotal', () => {
  it('is the home card balance once one is read on the current network', () => {
    const { store } = setup([makeKeyring(0, 1)])
    const { wrapper } = createHookTestHarness({ store })
    const { result } = renderHook(() => useCurrentAccountBalanceTotal(), { wrapper })
    const current = store.getState().accounts.current.address

    expect(result.current).toBeNull()

    act(() => {
      store.dispatch(
        accountActions.setBalanceV2({
          address: current,
          balance: {
            availableBalance: 0,
            unavailableBalance: 0,
            totalBalance: 4200,
            chainType: TESTNET,
          },
          requestId: 1,
        })
      )
    })
    // Read on another network: not this one's.
    expect(result.current).toBeNull()

    act(() => {
      store.dispatch(
        accountActions.setBalanceV2({
          address: current,
          balance: {
            availableBalance: 0,
            unavailableBalance: 0,
            totalBalance: 5100,
            chainType: MAINNET,
          },
          requestId: 2,
        })
      )
    })
    expect(result.current).toEqual({ address: current, totalBalance: 5100, stale: false })

    act(() => {
      store.dispatch(accountActions.setBalanceError({ address: current, requestId: 3 }))
    })
    expect(result.current).toEqual({ address: current, totalBalance: 5100, stale: true })
  })
})

describe('isSatoshiAmount', () => {
  it('takes only safe integers of 0 or more', () => {
    expect([0, 1, Number.MAX_SAFE_INTEGER].every(isSatoshiAmount)).toBe(true)
    expect(
      [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null, undefined, '5'].some(value =>
        isSatoshiAmount(value)
      )
    ).toBe(false)
  })
})

describe('storeAccountTotals', () => {
  it('keeps a stale mark through an answer that is not settled, and clears it with one that is', () => {
    const store = createAppTestStore()
    const addr = 'qb1zstale'
    const store1 = (requestId: number, totalBalance: number, stale: boolean, settled: boolean) =>
      store.dispatch(
        storeAccountTotals([
          { address: addr, chainType: MAINNET, requestId, totalBalance, readAt: 1, stale, settled },
        ])
      )
    const stored = () => store.getState().accounts.accountTotalsMap[MAINNET]![addr]

    store1(1, 5, true, true)
    store1(2, 6, false, false)
    expect(stored()).toMatchObject({ totalBalance: 6, stale: true, settled: false })
    store1(3, 7, false, true)
    expect(stored()).toMatchObject({ totalBalance: 7, stale: false, settled: true })
    // No mark to keep: an answer that is not settled stores none.
    store1(4, 8, false, false)
    expect(stored()).toMatchObject({ totalBalance: 8, stale: false, settled: false })
    // Another network's mark is its own.
    store.dispatch(
      storeAccountTotals([
        {
          address: addr,
          chainType: TESTNET,
          requestId: 5,
          totalBalance: 1,
          readAt: 1,
          stale: true,
          settled: true,
        },
      ])
    )
    store1(6, 9, false, false)
    expect(stored()).toMatchObject({ totalBalance: 9, stale: false })
  })

  it('stores nothing for a network the wallet does not have', () => {
    const store = createAppTestStore()
    for (const chainType of ['__proto__', 'constructor', 'hasOwnProperty', 'QBIT_NOWHERE']) {
      expect(() =>
        store.dispatch(
          storeAccountTotals([
            {
              address: 'qb1zhostile',
              chainType: chainType as ChainType,
              requestId: 1,
              totalBalance: 5,
              readAt: 1,
              stale: false,
              settled: true,
            },
          ])
        )
      ).not.toThrow()
    }
    expect(store.getState().accounts.accountTotalsMap).toEqual({})
    expect((Object as any)['qb1zhostile']).toBeUndefined()
    expect((Object.prototype.hasOwnProperty as any)['qb1zhostile']).toBeUndefined()
  })
})
