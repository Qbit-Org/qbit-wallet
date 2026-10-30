import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import { KeyringType } from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'
import {
  useFetchHistoryCallback,
  useHistory,
  useHistoryAutoRefresh,
  useHistoryScopeKey,
} from '../../src/hooks/accounts'
import { accountActions } from '../../src/reducers/accounts'
import { keyringsActions } from '../../src/reducers/keyrings'
import { settingsActions } from '../../src/reducers/settings'
import { createHookTestHarness, createWalletMock } from './testHelpers'

const address = 'qb1ztestaccount'

function createHarness() {
  const wallet = {
    ...createWalletMock(),
    getAddressHistory: vi.fn().mockResolvedValue({
      start: 0,
      total: 1,
      detail: [{ txid: 'tx1', confirmations: 0, timestamp: 1_700_000_000 }],
    }),
  }
  const harness = createHookTestHarness({ wallet: wallet as any })
  return { ...harness, wallet }
}

describe('useHistoryAutoRefresh', () => {
  it('brands a vanished pending tx replaced only after the node reports it gone', async () => {
    const wallet = {
      ...createWalletMock(),
      getAddressHistory: vi
        .fn()
        .mockResolvedValueOnce({
          start: 0,
          total: 2,
          detail: [
            { txid: 'tx-vanish', confirmations: 0, timestamp: 200 },
            { txid: 'tx-anchor', confirmations: 1, timestamp: 100 },
          ],
        })
        .mockResolvedValueOnce({
          start: 0,
          total: 1,
          detail: [{ txid: 'tx-anchor', confirmations: 2, timestamp: 100 }],
        }),
      getQbitTxLifecycleStatus: vi.fn().mockResolvedValue({ state: 'gone' }),
    }
    const { wrapper, store } = createHookTestHarness({ wallet: wallet as any })
    const { unmount } = renderHook(() => useHistoryAutoRefresh(), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    expect(wallet.getQbitTxLifecycleStatus).toHaveBeenCalledWith('tx-vanish')
    const list = store.getState().accounts.historyMap[address].list
    expect(list.find(item => item.txid === 'tx-vanish')).toMatchObject({ replaced: true })
    unmount()
  })

  it('leaves a vanished pending tx unflagged when the node says it confirmed', async () => {
    const wallet = {
      ...createWalletMock(),
      getAddressHistory: vi
        .fn()
        .mockResolvedValueOnce({
          start: 0,
          total: 2,
          detail: [
            { txid: 'tx-paged-out', confirmations: 0, timestamp: 200 },
            { txid: 'tx-anchor', confirmations: 1, timestamp: 100 },
          ],
        })
        .mockResolvedValueOnce({
          start: 0,
          total: 1,
          detail: [{ txid: 'tx-anchor', confirmations: 2, timestamp: 100 }],
        }),
      getQbitTxLifecycleStatus: vi.fn().mockResolvedValue({ state: 'confirmed' }),
    }
    const { wrapper, store } = createHookTestHarness({ wallet: wallet as any })
    const { unmount } = renderHook(() => useHistoryAutoRefresh(), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    const list = store.getState().accounts.historyMap[address].list
    expect(list.find(item => item.txid === 'tx-paged-out')).toBeUndefined()
    unmount()
  })

  it('records pending txids whose lifecycle probe succeeds', async () => {
    const wallet = {
      ...createWalletMock(),
      getAddressHistory: vi
        .fn()
        .mockResolvedValueOnce({
          start: 0,
          total: 2,
          detail: [
            { txid: 'tx-paged-out', confirmations: 0, timestamp: 200 },
            { txid: 'tx-anchor', confirmations: 1, timestamp: 100 },
          ],
        })
        .mockResolvedValueOnce({
          start: 0,
          total: 2,
          detail: [{ txid: 'tx-anchor', confirmations: 2, timestamp: 100 }],
        }),
      getQbitTxLifecycleStatus: vi.fn().mockResolvedValue({ state: 'pending' }),
    }
    const { wrapper, store } = createHookTestHarness({ wallet: wallet as any })
    const { unmount } = renderHook(() => useHistoryAutoRefresh(), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    const history = store.getState().accounts.historyMap[address]
    expect(history.list.find(item => item.txid === 'tx-paged-out')).toBeDefined()
    expect(history.verifiedPendingTxids).toEqual(['tx-paged-out'])
    unmount()
  })

  it('probes missing pending txs when the fresh page is full of pending rows', async () => {
    const fullPendingPage = Array.from({ length: 20 }, (_, index) => ({
      txid: `tx-fresh-${index}`,
      confirmations: 0,
      timestamp: 100 - index,
    }))
    const wallet = {
      ...createWalletMock(),
      getAddressHistory: vi
        .fn()
        .mockResolvedValueOnce({
          start: 0,
          total: 2,
          detail: [
            { txid: 'tx-gone', confirmations: 0, timestamp: 300 },
            { txid: 'tx-paged-out', confirmations: 0, timestamp: 200 },
          ],
        })
        .mockResolvedValueOnce({
          start: 0,
          total: 21,
          detail: fullPendingPage,
        }),
      getQbitTxLifecycleStatus: vi.fn(async (txid: string) => ({
        state: txid === 'tx-gone' ? 'gone' : 'pending',
      })),
    }
    const { wrapper, store } = createHookTestHarness({ wallet: wallet as any })
    const { unmount } = renderHook(() => useHistoryAutoRefresh(), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    expect(wallet.getQbitTxLifecycleStatus).toHaveBeenCalledWith('tx-gone')
    expect(wallet.getQbitTxLifecycleStatus).toHaveBeenCalledWith('tx-paged-out')
    const history = store.getState().accounts.historyMap[address]
    expect(history.list.find(item => item.txid === 'tx-gone')).toMatchObject({
      replaced: true,
    })
    expect(history.list.find(item => item.txid === 'tx-paged-out')).toMatchObject({
      confirmations: 0,
    })
    expect(history.list.find(item => item.txid === 'tx-paged-out')?.replaced).toBeUndefined()
    expect(history.verifiedPendingTxids).toEqual(['tx-paged-out'])
    unmount()
  })

  it('retains a vanished pending tx unflagged when its lifecycle probe fails', async () => {
    const wallet = {
      ...createWalletMock(),
      getAddressHistory: vi
        .fn()
        .mockResolvedValueOnce({
          start: 0,
          total: 2,
          detail: [
            { txid: 'tx-probe-error', confirmations: 0, timestamp: 200 },
            { txid: 'tx-anchor', confirmations: 1, timestamp: 100 },
          ],
        })
        .mockResolvedValueOnce({
          start: 0,
          total: 1,
          detail: [{ txid: 'tx-anchor', confirmations: 2, timestamp: 100 }],
        }),
      getQbitTxLifecycleStatus: vi.fn().mockRejectedValue(new Error('offline')),
    }
    const { wrapper, store } = createHookTestHarness({ wallet: wallet as any })
    const { unmount } = renderHook(() => useHistoryAutoRefresh(), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    expect(wallet.getQbitTxLifecycleStatus).toHaveBeenCalledWith('tx-probe-error')
    const history = store.getState().accounts.historyMap[address]
    const list = history.list
    const retained = list.find(item => item.txid === 'tx-probe-error')
    expect(retained).toMatchObject({ txid: 'tx-probe-error', confirmations: 0 })
    expect(retained?.replaced).toBeUndefined()
    expect(history.verifiedPendingTxids).toEqual([])
    unmount()
  })

  it('keeps manual callback generation protection when an older fetch resolves last', async () => {
    let resolveFirst!: (value: unknown) => void
    const first = new Promise(resolve => (resolveFirst = resolve))
    const wallet = {
      ...createWalletMock(),
      getAddressHistory: vi
        .fn()
        .mockReturnValueOnce(first)
        .mockResolvedValueOnce({
          start: 0,
          total: 1,
          detail: [{ txid: 'tx-new', confirmations: 1, timestamp: 100 }],
        }),
    }
    const { wrapper, store } = createHookTestHarness({ wallet: wallet as any })
    const { result, unmount } = renderHook(() => useFetchHistoryCallback(), { wrapper })

    let firstFetch!: Promise<void>
    let secondFetch!: Promise<void>
    act(() => {
      firstFetch = result.current()
      secondFetch = result.current()
    })
    await act(async () => {
      await secondFetch
    })
    expect(store.getState().accounts.historyMap[address].list).toMatchObject([{ txid: 'tx-new' }])

    await act(async () => {
      resolveFirst({
        start: 0,
        total: 1,
        detail: [{ txid: 'tx-stale', confirmations: 0, timestamp: 50 }],
      })
      await firstFetch
    })
    expect(store.getState().accounts.historyMap[address].list).toMatchObject([{ txid: 'tx-new' }])
    unmount()
  })

  it('does not advance the lifecycle probe cursor when a stale fetch resolves last', async () => {
    const pending = Array.from({ length: 61 }, (_, index) => ({
      txid: `tx-pending-${index}`,
      confirmations: 0,
      timestamp: 200 - index,
    }))
    let releaseStaleProbes!: (value: { state: 'pending' }) => void
    const staleProbe = new Promise<{ state: 'pending' }>(resolve => {
      releaseStaleProbes = resolve
    })
    let probeCallCount = 0
    const wallet = {
      ...createWalletMock(),
      getAddressHistory: vi.fn().mockResolvedValue({ start: 0, total: 0, detail: [] }),
      getQbitTxLifecycleStatus: vi.fn(() =>
        probeCallCount++ < 8 ? staleProbe : Promise.resolve({ state: 'pending' as const })
      ),
    }
    const { wrapper, store } = createHookTestHarness({ wallet: wallet as any })
    store.dispatch(accountActions.setHistory({ address, list: pending }))
    const { result, unmount } = renderHook(() => useFetchHistoryCallback(), { wrapper })

    let staleFetch!: Promise<void>
    act(() => {
      staleFetch = result.current()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(wallet.getQbitTxLifecycleStatus).toHaveBeenCalledTimes(8)

    await act(async () => {
      await result.current()
    })
    await act(async () => {
      releaseStaleProbes({ state: 'pending' })
      await staleFetch
    })

    wallet.getQbitTxLifecycleStatus.mockClear()
    await act(async () => {
      await result.current()
    })

    expect(wallet.getQbitTxLifecycleStatus.mock.calls[0]?.[0]).toBe('tx-pending-60')
    unmount()
  })

  it('preserves verified pending txids outside consecutive rotated probe windows', async () => {
    const pending = Array.from({ length: 61 }, (_, index) => ({
      txid: `tx-pending-${index}`,
      confirmations: 0,
      timestamp: 200 - index,
    }))
    const wallet = {
      ...createWalletMock(),
      getAddressHistory: vi.fn().mockResolvedValue({ start: 0, total: 0, detail: [] }),
      getQbitTxLifecycleStatus: vi.fn().mockResolvedValue({ state: 'pending' }),
    }
    const { wrapper, store } = createHookTestHarness({ wallet: wallet as any })
    store.dispatch(accountActions.setHistory({ address, list: pending }))
    const { result, unmount } = renderHook(() => useFetchHistoryCallback(), { wrapper })

    await act(async () => {
      await result.current()
    })
    expect(store.getState().accounts.historyMap[address].verifiedPendingTxids).toEqual(
      pending.slice(0, 60).map(item => item.txid)
    )

    await act(async () => {
      await result.current()
    })

    expect(wallet.getQbitTxLifecycleStatus.mock.calls[60]?.[0]).toBe('tx-pending-60')
    expect(store.getState().accounts.historyMap[address].verifiedPendingTxids).toEqual(
      pending.map(item => item.txid)
    )
    unmount()
  })

  it('invalidates prior verification for fresh and non-verified lifecycle outcomes', async () => {
    const candidates = Array.from({ length: 62 }, (_, index) => ({
      txid: `tx-candidate-${index}`,
      confirmations: 0,
      timestamp: 300 - index,
    }))
    const freshPending = {
      txid: 'tx-fresh-pending',
      confirmations: 0,
      timestamp: 400,
    }
    const freshConfirmed = {
      txid: 'tx-fresh-confirmed',
      confirmations: 2,
      timestamp: 399,
    }
    const wallet = {
      ...createWalletMock(),
      getAddressHistory: vi.fn().mockResolvedValue({
        start: 0,
        total: 2,
        detail: [freshPending, freshConfirmed],
      }),
      getQbitTxLifecycleStatus: vi.fn(async (txid: string) => {
        if (txid === 'tx-candidate-1') throw new Error('offline')
        if (txid === 'tx-candidate-2') return { state: 'confirmed' as const }
        if (txid === 'tx-candidate-3') return { state: 'gone' as const }
        return { state: 'pending' as const }
      }),
    }
    const { wrapper, store } = createHookTestHarness({ wallet: wallet as any })
    store.dispatch(
      accountActions.setHistory({
        address,
        list: [...candidates, freshPending, freshConfirmed],
        verifiedPendingTxids: [
          'tx-candidate-0',
          'tx-candidate-1',
          'tx-candidate-2',
          'tx-candidate-3',
          'tx-candidate-60',
          'tx-fresh-pending',
          'tx-fresh-confirmed',
          'tx-removed',
        ],
      })
    )
    const { result, unmount } = renderHook(() => useFetchHistoryCallback(), { wrapper })

    await act(async () => {
      await result.current()
    })

    const history = store.getState().accounts.historyMap[address]
    expect(history.verifiedPendingTxids).toContain('tx-candidate-0')
    expect(history.verifiedPendingTxids).toContain('tx-candidate-4')
    expect(history.verifiedPendingTxids).toContain('tx-candidate-60')
    expect(history.verifiedPendingTxids).not.toContain('tx-candidate-1')
    expect(history.verifiedPendingTxids).not.toContain('tx-candidate-2')
    expect(history.verifiedPendingTxids).not.toContain('tx-candidate-3')
    expect(history.verifiedPendingTxids).not.toContain('tx-fresh-pending')
    expect(history.verifiedPendingTxids).not.toContain('tx-fresh-confirmed')
    expect(history.verifiedPendingTxids).not.toContain('tx-removed')
    expect(new Set(history.verifiedPendingTxids ?? []).size).toBe(
      history.verifiedPendingTxids?.length
    )
    expect(history.list.find(item => item.txid === 'tx-candidate-2')).toBeUndefined()
    expect(history.list.find(item => item.txid === 'tx-candidate-3')).toMatchObject({
      replaced: true,
    })
    unmount()
  })

  it('starts lifecycle probes at the first candidate after the history scope changes', async () => {
    const nextAddress = 'bc1q-next-probe-scope'
    const pendingFor = (scope: string) =>
      Array.from({ length: 61 }, (_, index) => ({
        txid: `${scope}-pending-${index}`,
        confirmations: 0,
        timestamp: 200 - index,
      }))
    const wallet = {
      ...createWalletMock(),
      getAddressHistory: vi.fn().mockResolvedValue({ start: 0, total: 0, detail: [] }),
      getQbitTxLifecycleStatus: vi.fn().mockResolvedValue({ state: 'pending' }),
    }
    const { wrapper, store } = createHookTestHarness({ wallet: wallet as any })
    store.dispatch(accountActions.setHistory({ address, list: pendingFor('first') }))
    const { result, unmount } = renderHook(() => useFetchHistoryCallback(), { wrapper })

    await act(async () => {
      await result.current()
    })
    expect(wallet.getQbitTxLifecycleStatus.mock.calls[0]?.[0]).toBe('first-pending-0')

    wallet.getQbitTxLifecycleStatus.mockClear()
    const currentAccount = store.getState().accounts.current
    act(() => {
      store.dispatch(accountActions.setHistory({ address: nextAddress, list: pendingFor('next') }))
      store.dispatch(
        accountActions.setCurrent({
          ...currentAccount,
          address: nextAddress,
          key: 'account-2',
          index: 1,
        })
      )
    })

    await act(async () => {
      await result.current()
    })

    expect(wallet.getQbitTxLifecycleStatus.mock.calls[0]?.[0]).toBe('next-pending-0')
    unmount()
  })

  it('keeps an in-flight fetch bound to the history for its captured address', async () => {
    const nextAddress = 'qb1z-next-account'
    let resolveHistory!: (value: unknown) => void
    const historyRequest = new Promise(resolve => (resolveHistory = resolve))
    const wallet = {
      ...createWalletMock(),
      getAddressHistory: vi.fn().mockReturnValue(historyRequest),
      getQbitTxLifecycleStatus: vi.fn().mockResolvedValue({ state: 'gone' }),
    }
    const { wrapper, store } = createHookTestHarness({ wallet: wallet as any })
    const currentAccount = store.getState().accounts.current
    store.dispatch(
      accountActions.setHistory({
        address,
        list: [{ txid: 'tx-original-pending', confirmations: 0, timestamp: 200 }],
      })
    )
    store.dispatch(
      accountActions.setHistory({
        address: nextAddress,
        list: [{ txid: 'tx-next-account', confirmations: 0, timestamp: 300 }],
      })
    )
    const { result, unmount } = renderHook(() => useFetchHistoryCallback(), { wrapper })

    let pendingFetch!: Promise<void>
    act(() => {
      pendingFetch = result.current()
    })
    act(() => {
      store.dispatch(
        accountActions.setCurrent({
          ...currentAccount,
          address: nextAddress,
          key: 'account-2',
          index: 1,
        })
      )
    })

    await act(async () => {
      resolveHistory({
        start: 0,
        total: 1,
        detail: [{ txid: 'tx-anchor', confirmations: 1, timestamp: 100 }],
      })
      await pendingFetch
    })

    expect(wallet.getQbitTxLifecycleStatus).toHaveBeenCalledWith('tx-original-pending')
    expect(wallet.getQbitTxLifecycleStatus).not.toHaveBeenCalledWith('tx-next-account')
    const originalHistory = store.getState().accounts.historyMap[address].list
    expect(originalHistory).toMatchObject([
      { txid: 'tx-original-pending', replaced: true },
      { txid: 'tx-anchor' },
    ])
    expect(originalHistory.find(item => item.txid === 'tx-next-account')).toBeUndefined()
    expect(store.getState().accounts.historyMap[nextAddress].list).toMatchObject([
      { txid: 'tx-next-account' },
    ])
    unmount()
  })

  function qbitAccountsHarness(getAddressHistory: (...args: any[]) => unknown) {
    const firstAccount = {
      type: KeyringType.QbitHdKeyring,
      address: 'tq1zhistoryfirst',
      index: 0,
      pubkey: '11'.repeat(32),
      key: 'keyring_0#0',
      flag: 0,
    }
    const secondAccount = {
      ...firstAccount,
      address: 'tq1zhistorysecond',
      index: 1,
      pubkey: '22'.repeat(32),
      key: 'keyring_0#1',
    }
    const wallet = { ...createWalletMock(), getAddressHistory: vi.fn(getAddressHistory) }
    const harness = createHookTestHarness({ wallet: wallet as any })
    harness.store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    harness.store.dispatch(
      keyringsActions.setCurrent({
        key: 'keyring_0',
        index: 0,
        type: KeyringType.QbitHdKeyring,
        addressType: AddressType.P2MR,
        accounts: [firstAccount, secondAccount],
        alianName: 'Qbit Wallet',
        hdPath: "m/87'/1'/0'/0",
      })
    )
    harness.store.dispatch(accountActions.setCurrent(firstAccount))
    return {
      ...harness,
      wallet,
      firstAccount,
      secondAccount,
      firstKey: `qbit-account:${ChainType.QBIT_TESTNET4}:${'11'.repeat(32)}`,
      secondKey: `qbit-account:${ChainType.QBIT_TESTNET4}:${'22'.repeat(32)}`,
    }
  }

  it("keeps each Qbit account's history under its own key", async () => {
    const pageFor = (address: string) => ({
      start: 0,
      total: 1,
      detail: [
        {
          txid: address === 'tq1zhistoryfirst' ? 'tx-first' : 'tx-second',
          confirmations: 1,
          timestamp: 100,
        },
      ],
      snapshotId: address === 'tq1zhistoryfirst' ? 'snapshot-1' : 'snapshot-2',
      scopeKey: `qbit-account:${ChainType.QBIT_TESTNET4}:${
        address === 'tq1zhistoryfirst' ? '11'.repeat(32) : '22'.repeat(32)
      }`,
    })
    const { wrapper, store, wallet, firstAccount, secondAccount, firstKey, secondKey } =
      qbitAccountsHarness(async ({ address }: { address: string }) => pageFor(address))
    const { result, unmount } = renderHook(
      () => {
        useHistoryAutoRefresh()
        return { key: useHistoryScopeKey(), history: useHistory() }
      },
      { wrapper }
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.key).toBe(firstKey)
    expect(result.current.history).toMatchObject({
      list: [{ txid: 'tx-first' }],
      snapshotId: 'snapshot-1',
    })

    act(() => {
      store.dispatch(accountActions.setCurrent(secondAccount))
    })
    expect(result.current.key).toBe(secondKey)
    expect(result.current.history).toMatchObject({ list: [], expired: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // The second account has no snapshot of its own yet, so its first read
    // scans afresh rather than refreshing the first account's snapshot.
    expect(wallet.getAddressHistory).toHaveBeenLastCalledWith({
      address: secondAccount.address,
      start: 0,
      limit: 20,
    })
    expect(result.current.history).toMatchObject({
      list: [{ txid: 'tx-second' }],
      snapshotId: 'snapshot-2',
    })
    expect(store.getState().accounts.historyMap[firstKey]).toMatchObject({
      list: [{ txid: 'tx-first' }],
      snapshotId: 'snapshot-1',
    })

    act(() => {
      store.dispatch(accountActions.setCurrent(firstAccount))
    })
    expect(result.current.history.list).toMatchObject([{ txid: 'tx-first' }])
    unmount()
  })

  it("drops the previous account's read when it finishes after an account switch", async () => {
    let resolveFirst!: (value: unknown) => void
    const { wrapper, store, secondAccount, firstKey, secondKey } = qbitAccountsHarness(
      () => new Promise(resolve => (resolveFirst = resolve))
    )
    store.dispatch(
      accountActions.setHistory({
        address: secondKey,
        list: [{ txid: 'tx-second', confirmations: 1, timestamp: 300 } as any],
        snapshotId: 'snapshot-2',
      })
    )
    const { result, unmount } = renderHook(
      () => ({ fetch: useFetchHistoryCallback(), history: useHistory() }),
      { wrapper }
    )

    let firstRead!: Promise<void>
    act(() => {
      firstRead = result.current.fetch()
    })
    act(() => {
      store.dispatch(accountActions.setCurrent(secondAccount))
    })
    await act(async () => {
      resolveFirst({
        start: 0,
        total: 1,
        detail: [{ txid: 'tx-first', confirmations: 1, timestamp: 100 }],
        snapshotId: 'snapshot-1',
        scopeKey: firstKey,
      })
      await firstRead
    })

    expect(result.current.history).toMatchObject({
      list: [{ txid: 'tx-second' }],
      snapshotId: 'snapshot-2',
    })
    expect(store.getState().accounts.historyMap[secondKey].list).toHaveLength(1)
    expect(store.getState().accounts.historyMap[firstKey]).toMatchObject({
      list: [{ txid: 'tx-first' }],
    })
    unmount()
  })

  it('shows no account the history stored under the earlier wallet-wide key', () => {
    const { wrapper, store, secondAccount } = qbitAccountsHarness(async () => ({
      start: 0,
      total: 0,
      detail: [],
    }))
    store.dispatch(
      accountActions.setHistory({
        address: `qbit:${ChainType.QBIT_TESTNET4}:${'11'.repeat(32)}`,
        list: [
          { txid: 'tx-first', confirmations: 1, timestamp: 200 } as any,
          { txid: 'tx-second', confirmations: 1, timestamp: 100 } as any,
        ],
        total: 2,
        snapshotId: 'snapshot-wallet',
      })
    )
    const { result, unmount } = renderHook(() => useHistory(), { wrapper })

    expect(result.current).toMatchObject({ list: [], expired: true, snapshotId: undefined })
    act(() => {
      store.dispatch(accountActions.setCurrent(secondAccount))
    })
    expect(result.current).toMatchObject({ list: [], expired: true, snapshotId: undefined })
    unmount()
  })

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fetches the first history page on mount and stores it', async () => {
    const { wrapper, store, wallet } = createHarness()
    const { unmount } = renderHook(() => useHistoryAutoRefresh(), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(wallet.getAddressHistory).toHaveBeenCalledTimes(1)
    expect(wallet.getAddressHistory).toHaveBeenCalledWith({ address, start: 0, limit: 20 })
    expect(store.getState().accounts.historyMap[address].list).toMatchObject([{ txid: 'tx1' }])
    expect(store.getState().accounts.historyMap[address].total).toBe(1)
    expect(store.getState().accounts.historyMap[address].firstPageTxids).toEqual(['tx1'])
    expect(store.getState().accounts.historyMap[address].verifiedPendingTxids).toEqual([])
    expect(store.getState().accounts.historyMap[address].expired).toBe(false)
    unmount()
  })

  it('refetches on the block cadence interval while mounted', async () => {
    const { wrapper, wallet } = createHarness()
    const { unmount } = renderHook(() => useHistoryAutoRefresh(), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(wallet.getAddressHistory).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(wallet.getAddressHistory).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(wallet.getAddressHistory).toHaveBeenCalledTimes(3)
    unmount()
  })

  it('does not overlap interval ticks while a history poll is still in flight', async () => {
    let resolveFirst!: (value: unknown) => void
    const firstRequest = new Promise(resolve => (resolveFirst = resolve))
    const wallet = {
      ...createWalletMock(),
      getAddressHistory: vi
        .fn()
        .mockReturnValueOnce(firstRequest)
        .mockResolvedValue({
          start: 0,
          total: 1,
          detail: [{ txid: 'tx-next', confirmations: 1, timestamp: 100 }],
        }),
    }
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { unmount } = renderHook(() => useHistoryAutoRefresh(), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000)
    })
    expect(wallet.getAddressHistory).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirst({
        start: 0,
        total: 1,
        detail: [{ txid: 'tx-first', confirmations: 1, timestamp: 50 }],
      })
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(wallet.getAddressHistory).toHaveBeenCalledTimes(2)
    unmount()
  })

  it('ignores a slower poll response after a manual retry succeeds', async () => {
    let resolvePoll!: (value: unknown) => void
    const pollRequest = new Promise(resolve => (resolvePoll = resolve))
    const wallet = {
      ...createWalletMock(),
      getAddressHistory: vi
        .fn()
        .mockReturnValueOnce(pollRequest)
        .mockResolvedValueOnce({
          start: 0,
          total: 1,
          detail: [{ txid: 'tx-manual', confirmations: 1, timestamp: 100 }],
        }),
    }
    const { wrapper, store } = createHookTestHarness({ wallet: wallet as any })
    const { result, unmount } = renderHook(() => useHistoryAutoRefresh(), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    let manualRetry!: Promise<void>
    act(() => {
      manualRetry = result.current()
    })
    await act(async () => {
      await manualRetry
    })
    expect(store.getState().accounts.historyMap[address].list).toMatchObject([
      { txid: 'tx-manual' },
    ])

    await act(async () => {
      resolvePoll({
        start: 0,
        total: 1,
        detail: [{ txid: 'tx-stale-poll', confirmations: 0, timestamp: 50 }],
      })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(store.getState().accounts.historyMap[address].list).toMatchObject([
      { txid: 'tx-manual' },
    ])
    unmount()
  })

  it('ignores a slower manual retry after a newer interval poll succeeds', async () => {
    let resolveManual!: (value: unknown) => void
    const manualRequest = new Promise(resolve => (resolveManual = resolve))
    const wallet = {
      ...createWalletMock(),
      getAddressHistory: vi
        .fn()
        .mockResolvedValueOnce({
          start: 0,
          total: 1,
          detail: [{ txid: 'tx-initial', confirmations: 1, timestamp: 50 }],
        })
        .mockReturnValueOnce(manualRequest)
        .mockResolvedValueOnce({
          start: 0,
          total: 1,
          detail: [{ txid: 'tx-new-poll', confirmations: 2, timestamp: 100 }],
        }),
    }
    const { wrapper, store } = createHookTestHarness({ wallet: wallet as any })
    const { result, unmount } = renderHook(() => useHistoryAutoRefresh(), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    let manualRetry!: Promise<void>
    act(() => {
      manualRetry = result.current()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(store.getState().accounts.historyMap[address].list).toMatchObject([
      { txid: 'tx-new-poll' },
    ])

    await act(async () => {
      resolveManual({
        start: 0,
        total: 1,
        detail: [{ txid: 'tx-stale-manual', confirmations: 1, timestamp: 75 }],
      })
      await manualRetry
    })
    expect(store.getState().accounts.historyMap[address].list).toMatchObject([
      { txid: 'tx-new-poll' },
    ])
    unmount()
  })

  it('supports a custom refresh interval', async () => {
    const { wrapper, wallet } = createHarness()
    const { unmount } = renderHook(() => useHistoryAutoRefresh(5_000), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(wallet.getAddressHistory).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(wallet.getAddressHistory).toHaveBeenCalledTimes(2)
    unmount()
  })

  it('stops refetching after unmount', async () => {
    const { wrapper, wallet } = createHarness()
    const { unmount } = renderHook(() => useHistoryAutoRefresh(), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(wallet.getAddressHistory).toHaveBeenCalledTimes(1)

    unmount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000)
    })
    expect(wallet.getAddressHistory).toHaveBeenCalledTimes(1)
  })

  it('keeps polling after a failed fetch', async () => {
    const { wrapper, wallet } = createHarness()
    wallet.getAddressHistory.mockRejectedValueOnce(new Error('offline'))
    const { unmount } = renderHook(() => useHistoryAutoRefresh(), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(wallet.getAddressHistory).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(wallet.getAddressHistory).toHaveBeenCalledTimes(2)
    unmount()
  })
})
