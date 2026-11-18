import { act, render, renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChainType } from '@qbit/wallet-types'

import { useStartBalanceReadCallback } from '../../src/hooks/accounts'
import { startBalancePoll, useBalanceCardLogic } from '../../src/ui-hooks/useBalanceCardLogic'
import { accountActions } from '../../src/reducers/accounts'
import { settingsActions } from '../../src/reducers/settings'
import { unhandledRejectionsDuring } from '../../../../tests/support/unhandledRejections'
import { createHookTestHarness, createWalletMock } from './testHelpers'

const address = 'qbit-many-outputs'

afterEach(() => {
  vi.useRealTimers()
})

type CardLogic = ReturnType<typeof useBalanceCardLogic>
/** The kind of value the card shows for Available and Unavailable, if it shows one. */
const splitKind = (card: CardLogic) =>
  card.status.kind === 'loading' || card.status.kind === 'failed-empty'
    ? undefined
    : card.status.shown.split.kind

/** A background whose balance reads stay in flight: the card shows what the store holds. */
const walletReadingForever = () => ({
  ...createWalletMock(),
  getAddressBalanceV2: () => new Promise<never>(() => undefined),
})

function renderBalanceCard(balance: Record<string, unknown>) {
  const harness = createHookTestHarness({ wallet: walletReadingForever() as any })
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
    // A lasting cause, stated: not a split still loading.
    expect(result.current.status.kind).toBe('ready')
    expect(splitKind(result.current)).toBe('limit')
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
    expect(result.current.status.kind).toBe('ready')
    expect(splitKind(result.current)).toBe('known')
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

    // The first poll at 10 s, then while nothing complete is shown 1.5, 3
    // and 6 s after each failure, then the back-off from 10 s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000)
    })
    expect(wallet.getAddressBalanceV2).toHaveBeenCalledTimes(5)
    expectUnknown(result)
    expect(result.current.status.kind).toBe('failed-empty')

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
    // At 50.5 s, after the back-off of 20 s, then every 10 s.
    expect(wallet.getAddressBalanceV2).toHaveBeenCalledTimes(8)
    expect(result.current.status.kind).toBe('ready')
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
    // Unknown for a passing reason: loading, not `--` with a note.
    expect(result.current.status.kind).toBe('total')
    expect(splitKind(result.current)).toBe('loading')
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
// The same two of the account whose balance the polling tests show
// (`balance`): its total, the split not read.
const incompleteOfShown = {
  ...incompleteRead,
  unavailableBalance: 5_000,
  totalBalance: 5_000,
}
const failedOfShown = { ...incompleteOfShown, utxoReadFailed: true }
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
  vi.useFakeTimers({ toFake: ['Date'] })
  const wallet = {
    ...createWalletMock(),
    ...explorer,
  }
  const harness = createHookTestHarness({ wallet: wallet as any })
  harness.store.dispatch(
    accountActions.setCurrent({ address, pubkey: '11'.repeat(32), type: 'Qbit HD Key Tree' } as any)
  )
  const { result } = renderHook(
    () => ({ card: useBalanceCardLogic(), fetchBalance: useStartBalanceReadCallback() }),
    { wrapper: harness.wrapper }
  )
  return { result, wallet, store: harness.store }
}

/**
 * A read the user asks for, 10 s after the last read, waited for: the clock
 * (only `Date`, faked by `renderWithExplorer`) moves on, so that two failed
 * reads in a row count as a failure the card shows (see
 * `balanceCardStatus`). Begun as the refresh control's read begins.
 */
async function readAgain(result: {
  current: { fetchBalance: (options?: { byUser?: boolean }) => Promise<unknown> }
}) {
  vi.setSystemTime(Date.now() + 10_000)
  await act(async () => {
    await result.current.fetchBalance({ byUser: true }).catch(() => undefined)
  })
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

    // One failed read is still loading; two in a row are a failure.
    await readAgain(result)
    expect(result.current.card.status.kind).toBe('loading')
    expect(result.current.card.balanceErrorText).toBeUndefined()
    await readAgain(result)

    expect(result.current.card.status.kind).toBe('failed-empty')
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
        .mockRejectedValueOnce(new Error('explorer down'))
        .mockResolvedValue(balance),
    })

    await readAgain(result)
    await readAgain(result)
    expect(result.current.card.status.kind).toBe('failed-empty')

    await readAgain(result)
    expect(result.current.card.status.kind).toBe('ready')
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

    await readAgain(result)
    await readAgain(result)
    // One failed refresh: the last balance stays, dimmed, as being refreshed.
    expect(result.current.card.status).toMatchObject({ kind: 'refreshing', reason: 'retry' })
    expect(result.current.card.balanceErrorText).toBeUndefined()
    await readAgain(result)

    expect(result.current.card.status.kind).toBe('failed')
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

    await readAgain(result)
    await readAgain(result)
    await readAgain(result)

    expect(result.current.card.status.kind).toBe('failed')
    expect(result.current.card.balanceErrorText).toBe('balance_refresh_error')
    expect(result.current.card.balanceValue).toBe('0.91000000')
    expect(result.current.card.utxoLimitExceeded).toBe(true)
    expect(result.current.card.balanceSplitUnknown).toBe(true)
    expect(result.current.card.availableAmount).toBe('--')
    expect(result.current.card.unavailableAmount).toBe('--')
  })

  it('reads at once for a press of the refresh control under a failure, and a second press joins that read', async () => {
    let fail!: (error: Error) => void
    const getAddressBalanceV2 = vi
      .fn()
      .mockRejectedValueOnce(new Error('explorer down'))
      .mockRejectedValueOnce(new Error('explorer down'))
      .mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject
          })
      )
    const { result } = renderWithExplorer({ getAddressBalanceV2 })
    await readAgain(result)
    // One failed read: still loading, not yet a failure.
    expect(result.current.card.status.kind).toBe('loading')
    await readAgain(result)
    expect(result.current.card.status.kind).toBe('failed-empty')

    act(() => {
      result.current.card.refreshBalance()
      result.current.card.refreshBalance()
    })
    expect(getAddressBalanceV2).toHaveBeenCalledTimes(3)
    expect(result.current.card.status).toMatchObject({ kind: 'failed-empty', busy: true })

    await act(async () => {
      fail(new Error('explorer down'))
    })
    expect(result.current.card.status).toMatchObject({ kind: 'failed-empty', busy: false })
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

    expect(result.current.card.balanceErrorText).toBeUndefined()
    expect(result.current.card.balanceValue).toBe('0.91000000')
    expect(result.current.card.status.kind).toBe('total')
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
    expect(result.current.card.status.kind).toBe('loading')

    await act(async () => {
      pending[0].resolve(balance)
      await older
    })

    // The newer read's failure stays the outcome: the balance is dimmed as
    // being refreshed, and one failure is no error yet.
    expect(result.current.card.status).toMatchObject({ kind: 'refreshing', reason: 'retry' })
    expect(result.current.card.balanceErrorText).toBeUndefined()
    expect(result.current.card.balanceValue).toBe('0.00005000')
  })

  it.each([
    // The newer read did not answer in full: the older split shows, dimmed
    // as being refreshed, as after a newer refresh that fails.
    [
      'shows a full answer finishing after a newer incomplete one, dimmed as being refreshed',
      fullRead,
      incompleteRead,
      'refreshing',
    ],
    [
      'does not let an incomplete answer finishing after a newer full one change the newer one',
      incompleteRead,
      fullRead,
      'ready',
    ],
  ])('%s', async (_case, olderAnswer, newerAnswer, kind) => {
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

    expect(result.current.card.status.kind).toBe(kind)
    expect(result.current.card.balanceValue).toBe('0.91000000')
    expect(result.current.card.availableAmount).toBe('0.60000000')
    expect(result.current.card.unavailableAmount).toBe('0.31000000')
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
    expect(card.status.kind).not.toBe('failed')
    expect(card.status.kind).not.toBe('failed-empty')
    expect(card.balanceErrorText).toBeUndefined()
  }

  it('shows `--` and no error while the first read is still running', async () => {
    let answer!: (value: unknown) => void
    const getAddressBalanceV2 = vi.fn(() => new Promise((resolve) => (answer = resolve)))
    const { result } = renderWithExplorer({ getAddressBalanceV2 })

    expect(result.current.card.status.kind).toBe('loading')
    expect(result.current.card.balanceValue).toBe('--')
    expectNoError(result.current.card)

    act(() => {
      void result.current.fetchBalance({ byUser: true })
    })
    expect(result.current.card.status.kind).toBe('loading')
    expect(result.current.card.balanceValue).toBe('--')
    expect(result.current.card.availableAmount).toBe('--')
    expect(result.current.card.unavailableAmount).toBe('--')
    expectNoError(result.current.card)

    await act(async () => {
      answer(balance)
    })
    expect(result.current.card.status.kind).toBe('ready')
    expect(result.current.card.balanceValue).toBe('0.00005000')
    expectNoError(result.current.card)
  })

  it('shows the load error, and `--` rather than 0, when the first read fails', async () => {
    const { result } = renderWithExplorer({
      getAddressBalanceV2: vi.fn().mockRejectedValue(new Error('explorer unreachable')),
    })

    await readAgain(result)
    await readAgain(result)

    expect(result.current.card.status.kind).toBe('failed-empty')
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
      getAddressBalanceV2: vi
        .fn()
        .mockResolvedValueOnce(balance)
        .mockRejectedValue(new Error('explorer down')),
    })

    await readAgain(result)
    expectNoError(result.current.card)
    await readAgain(result)
    expectNoError(result.current.card)
    await readAgain(result)

    expect(result.current.card.status.kind).toBe('failed')
    expect(result.current.card.balanceErrorText).toBe('balance_refresh_error')
    expect(result.current.card.balanceValue).toBe('0.00005000')
    expect(result.current.card.availableAmount).toBe('0.00005000')
    expect(result.current.card.unavailableAmount).toBe('0.00000000')
    expect(result.current.card.utxoLimitExceeded).toBe(false)
  })

  it('names the explorer limit, with no error, for an over-limit read', async () => {
    const { result } = renderWithExplorer({
      getAddressBalanceV2: vi.fn().mockResolvedValue(overLimitRead),
    })

    await readAgain(result)

    expectNoError(result.current.card)
    expect(result.current.card.status.kind).toBe('ready')
    expect(result.current.card.balanceValue).toBe('0.91000000')
    expect(result.current.card.utxoLimitExceeded).toBe(true)
    expect(result.current.card.balanceSplitUnknown).toBe(true)
    expect(result.current.card.availableAmount).toBe('--')
    expect(result.current.card.unavailableAmount).toBe('--')
  })

  it('shows the total with the split loading, no explorer note and no error, while a broadcast holds the send guard', async () => {
    const { result } = renderWithExplorer({
      getAddressBalanceV2: vi.fn().mockResolvedValue(guardHeldRead),
    })

    await readAgain(result)

    expectNoError(result.current.card)
    expect(result.current.card.isCurrentChainBalance).toBe(true)
    expect(result.current.card.status.kind).toBe('total')
    expect(splitKind(result.current.card)).toBe('loading')
    expect(result.current.card.balanceValue).toBe('0.91000000')
    expect(result.current.card.availableAmount).toBe('--')
    expect(result.current.card.unavailableAmount).toBe('--')
    expect(result.current.card.utxoLimitExceeded).toBe(false)
    expect(result.current.card.balanceSplitUnknown).toBe(false)
  })

  it('clears a failed first read once a guard-held read succeeds', async () => {
    const { result } = renderWithExplorer({
      getAddressBalanceV2: vi
        .fn()
        .mockRejectedValueOnce(new Error('explorer unreachable'))
        .mockResolvedValue(guardHeldRead),
    })

    await readAgain(result)
    expect(result.current.card.status.kind).toBe('loading')

    await readAgain(result)
    expectNoError(result.current.card)
    expect(result.current.card.balanceValue).toBe('0.91000000')
    expect(result.current.card.availableAmount).toBe('--')
    expect(result.current.card.balanceSplitUnknown).toBe(false)
  })
})

describe('useBalanceCardLogic while the outputs are still being read', () => {
  type Card = ReturnType<typeof useBalanceCardLogic>
  const expectIncomplete = (card: Card) => {
    expect(card.isCurrentChainBalance).toBe(true)
    expect(card.balanceValue).toBe('0.91000000')
    // The total is known, the split loading: no note, no `--`.
    expect(splitKind(card)).toBe('loading')
    expect(card.availableBalance).toBeNull()
    expect(card.unavailableBalance).toBeNull()
    expect(card.availableAmount).toBe('--')
    expect(card.unavailableAmount).toBe('--')
    // Neither the explorer's limit nor a failed read.
    expect(card.utxoLimitExceeded).toBe(false)
    expect(card.balanceSplitUnknown).toBe(false)
    expect(card.status.kind).not.toBe('failed-empty')
  }

  it('shows the total with the split loading rather than the load error', async () => {
    const { result } = renderWithExplorer({
      getAddressBalanceV2: vi.fn().mockResolvedValue(incompleteRead),
    })

    await readAgain(result)

    expectIncomplete(result.current.card)
    expect(result.current.card.status.kind).toBe('total')
    expect(result.current.card.balanceErrorText).toBeUndefined()
  })

  it('shows the split once a read finishes the outputs', async () => {
    const { result } = renderWithExplorer({
      getAddressBalanceV2: vi
        .fn()
        .mockResolvedValueOnce(incompleteRead)
        .mockResolvedValueOnce(incompleteRead)
        .mockResolvedValue(fullRead),
    })

    await readAgain(result)
    expectIncomplete(result.current.card)
    await readAgain(result)
    expectIncomplete(result.current.card)
    await readAgain(result)

    expect(result.current.card.status.kind).toBe('ready')
    expect(result.current.card.balanceValue).toBe('0.91000000')
    expect(result.current.card.availableAmount).toBe('0.60000000')
    expect(result.current.card.unavailableAmount).toBe('0.31000000')
    expect(result.current.card.balanceErrorText).toBeUndefined()
  })

  it('keeps the total with the split loading through a failed refresh, and says the outputs could not be read after another', async () => {
    const { result } = renderWithExplorer({
      getAddressBalanceV2: vi
        .fn()
        .mockResolvedValueOnce(incompleteRead)
        .mockRejectedValue(new Error('explorer down')),
    })

    await readAgain(result)
    await readAgain(result)
    expectIncomplete(result.current.card)
    expect(result.current.card.status.kind).toBe('total')
    expect(result.current.card.balanceErrorText).toBeUndefined()

    await readAgain(result)
    expectIncomplete(result.current.card)
    expect(result.current.card.status.kind).toBe('failed')
    // No box: the two notes, and `--` for the split (O4). The total is the
    // first read's, out of date: dimmed.
    expect(result.current.card.balanceErrorText).toBeUndefined()
    expect(result.current.card.outputsUnreadText).toBe('balance_outputs_incomplete')
    expect(result.current.card.outputsUnreadDetailText).toBe('balance_outputs_incomplete_detail')
    expect(result.current.card.totalDimmed).toBe(true)
  })

  it('shows loading, not an error, when the first read fails, and the total once a read has the statistics', async () => {
    const { result } = renderWithExplorer({
      getAddressBalanceV2: vi
        .fn()
        .mockRejectedValueOnce(new Error('explorer unreachable'))
        .mockResolvedValue(incompleteRead),
    })

    await readAgain(result)
    expect(result.current.card.status.kind).toBe('loading')
    expect(result.current.card.balanceErrorText).toBeUndefined()

    // Read again, and the background has read the statistics this time.
    await readAgain(result)
    expectIncomplete(result.current.card)
    expect(result.current.card.balanceErrorText).toBeUndefined()
  })

  it('shows only the total, the split loading, even for an incomplete answer that carries a split', () => {
    // A split counted from part of the outputs is never shown.
    const result = renderBalanceCard({ ...fullRead, utxoReadIncomplete: true })

    expect(result.current.status.kind).toBe('total')
    expect(result.current.balanceValue).toBe('0.91000000')
    expect(result.current.availableAmount).toBe('--')
    expect(result.current.unavailableAmount).toBe('--')
  })

  it("does not show another network's total", () => {
    const result = renderBalanceCard({ ...incompleteRead, chainType: ChainType.QBIT_TESTNET4 })

    expect(result.current.status.kind).toBe('loading')
    expect(result.current.balanceValue).toBe('--')
  })
})

describe('useBalanceCardLogic when the outputs cannot be read (O4)', () => {
  it('keeps the total at full opacity under the failure when its own statistics answered and only its outputs failed', async () => {
    const { result } = renderWithExplorer({
      getAddressBalanceV2: vi.fn().mockResolvedValue(failedRead),
    })
    await readAgain(result)
    await readAgain(result)
    expect(result.current.card.status).toMatchObject({ kind: 'failed', totalCurrent: true })
    expect(result.current.card.balanceValue).toBe('0.91000000')
    expect(result.current.card.outputsUnreadText).toBe('balance_outputs_incomplete')
    expect(result.current.card.balanceErrorText).toBeUndefined()
    expect(result.current.card.availableAmount).toBe('--')
    expect(result.current.card.totalDimmed).toBe(false)
    expect(result.current.card.splitDimmed).toBe(false)
  })
})

describe('useBalanceCardLogic breakdown (O5)', () => {
  it('starts closed, and stays as the user leaves it when the card is shown again on another visit to the screen', () => {
    const harness = createHookTestHarness({ wallet: createWalletMock() as any })
    harness.store.dispatch(
      accountActions.setCurrent({
        address,
        pubkey: '11'.repeat(32),
        type: 'Qbit HD Key Tree',
      } as any)
    )
    const first = renderHook(() => useBalanceCardLogic(), { wrapper: harness.wrapper })
    expect(first.result.current.isDetailExpanded).toBe(false)
    act(() => first.result.current.handleExpandToggle())
    expect(first.result.current.isDetailExpanded).toBe(true)
    first.unmount()

    const again = renderHook(() => useBalanceCardLogic(), { wrapper: harness.wrapper })
    expect(again.result.current.isDetailExpanded).toBe(true)
    act(() => again.result.current.handleExpandToggle())
    again.unmount()
    const third = renderHook(() => useBalanceCardLogic(), { wrapper: harness.wrapper })
    expect(third.result.current.isDetailExpanded).toBe(false)
    third.unmount()
  })
})

describe('useBalanceCardLogic when a refresh cannot read every output of a balance already shown', () => {
  // Read later, with a total that moved since: the new total shows, its
  // split loading, for the old split would not add up with it.
  const laterIncomplete = {
    ...incompleteRead,
    unavailableBalance: 92_000_000,
    totalBalance: 92_000_000,
  }
  const laterFailed = { ...laterIncomplete, utxoReadFailed: true }
  const laterFull = {
    ...fullRead,
    availableBalance: 62_000_000,
    unavailableBalance: 30_000_000,
    totalBalance: 92_000_000,
  }
  type Card = ReturnType<typeof useBalanceCardLogic>
  // The newer total, with the split loading: no note, and no error.
  const expectNewerTotal = (card: Card) => {
    expect(card.balanceValue).toBe('0.92000000')
    expect(card.availableAmount).toBe('--')
    expect(card.unavailableAmount).toBe('--')
    expect(card.status.kind).toBe('total')
    expect(card.balanceErrorText).toBeUndefined()
    expect(splitKind(card)).toBe('loading')
    expect(card.balanceSplitUnknown).toBe(false)
  }
  // The last figures, dimmed as being refreshed: no note, no `--`, and no
  // error until reads keep failing.
  const expectLastFiguresOutOfDate = (card: Card, kind: 'refreshing' | 'failed' = 'refreshing') => {
    expect(card.balanceValue).toBe('0.91000000')
    expect(card.availableAmount).toBe('0.60000000')
    expect(card.unavailableAmount).toBe('0.31000000')
    expect(card.status.kind).toBe(kind)
    expect(card.balanceErrorText).toBe(kind === 'failed' ? 'balance_refresh_error' : undefined)
    expect(splitKind(card)).toBe('known')
    expect(card.balanceSplitUnknown).toBe(false)
  }

  it.each<[string, unknown, (card: Card) => void]>([
    [
      'ran out of time part of the way through',
      incompleteRead,
      card => expectLastFiguresOutOfDate(card),
    ],
    ['failed', failedRead, card => expectLastFiguresOutOfDate(card)],
    [
      'ran out of time part of the way through, with a total that moved',
      laterIncomplete,
      expectNewerTotal,
    ],
    ['failed, with a total that moved', laterFailed, expectNewerTotal],
  ])(
    'keeps the last figures with the same total, dimmed as being refreshed, and shows a newer total with the split loading, with no error and no outputs note, when the read of the outputs %s; a full answer read again clears it',
    async (_how, answer, expectShown) => {
      const { result } = renderWithExplorer({
        getAddressBalanceV2: vi
          .fn()
          .mockResolvedValueOnce(fullRead)
          .mockResolvedValueOnce(answer)
          .mockResolvedValue(laterFull),
      })

      await readAgain(result)
      expect(result.current.card.availableAmount).toBe('0.60000000')
      expect(result.current.card.balanceErrorText).toBeUndefined()
      // The user opens the breakdown (closed by default).
      act(() => result.current.card.handleExpandToggle())

      await readAgain(result)
      expectShown(result.current.card)
      // The breakdown stays open.
      expect(result.current.card.isDetailExpanded).toBe(true)

      await readAgain(result)
      expect(result.current.card.balanceErrorText).toBeUndefined()
      expect(result.current.card.status.kind).toBe('ready')
      expect(result.current.card.balanceValue).toBe('0.92000000')
      expect(result.current.card.availableAmount).toBe('0.62000000')
      expect(result.current.card.unavailableAmount).toBe('0.30000000')
    }
  )

  it.each([
    ['ran out of time part of the way through', incompleteRead],
    ['failed', failedRead],
  ])(
    'shows the total with the split loading, and no error, when the first read of the outputs %s',
    async (_how, answer) => {
      const { result } = renderWithExplorer({
        getAddressBalanceV2: vi.fn().mockResolvedValue(answer),
      })

      await readAgain(result)

      expect(result.current.card.balanceValue).toBe('0.91000000')
      expect(result.current.card.availableAmount).toBe('--')
      expect(result.current.card.unavailableAmount).toBe('--')
      expect(result.current.card.status.kind).toBe('total')
      expect(splitKind(result.current.card)).toBe('loading')
      expect(result.current.card.balanceErrorText).toBeUndefined()
    }
  )

  it('keeps the last figures through several such answers, and a rejection after them', async () => {
    const { result } = renderWithExplorer({
      getAddressBalanceV2: vi
        .fn()
        .mockResolvedValueOnce(fullRead)
        .mockResolvedValueOnce(failedRead)
        .mockResolvedValueOnce(incompleteRead)
        .mockRejectedValueOnce(new Error('explorer down'))
        .mockRejectedValueOnce(new Error('explorer down'))
        .mockResolvedValue(laterFull),
    })

    await readAgain(result)
    // A failed read, then a partial one, which ends that trouble, then two
    // rejections 10 s apart: the second shows the error.
    for (const kind of ['refreshing', 'refreshing', 'refreshing', 'failed'] as const) {
      await readAgain(result)
      expectLastFiguresOutOfDate(result.current.card, kind)
    }
    await readAgain(result)
    expect(result.current.card.balanceErrorText).toBeUndefined()
    expect(result.current.card.availableAmount).toBe('0.62000000')
  })

  it('resolves the read with the answer itself, so a caller still sees that the read of the outputs failed', async () => {
    const { result, store } = renderWithExplorer({
      getAddressBalanceV2: vi.fn().mockResolvedValueOnce(fullRead).mockResolvedValue(laterFailed),
    })

    await readAgain(result)
    let answer: unknown
    await act(async () => {
      answer = await result.current.fetchBalance()
    })

    expect(answer).toEqual(laterFailed)
    expect(store.getState().accounts.balanceStatusMap[address]?.error).toBe(true)
    expectNewerTotal(result.current.card)
  })

  it.each<[string, unknown, unknown, string, string]>([
    // The newer refresh failed, and stays the outcome over the older balance.
    [
      'an older full answer after a newer one that could not read every output, dimmed as being refreshed',
      fullRead,
      failedRead,
      'refreshing',
      '0.60000000',
    ],
    // The newer refresh read a total that moved: that total, its split loading.
    [
      'the total of a newer answer that could not read every output, not an older full answer of another total',
      fullRead,
      laterFailed,
      'total',
      '--',
    ],
    // The newer full answer stands.
    [
      'nothing of an older answer that could not read every output after a newer full one',
      laterFailed,
      laterFull,
      'ready',
      '0.62000000',
    ],
  ])('shows %s', async (_case, olderAnswer, newerAnswer, kind, available) => {
    const { pending, getAddressBalanceV2 } = pendingReads()
    const { result, store } = renderWithExplorer({ getAddressBalanceV2 })
    // A split shown before both refreshes.
    const shown = { ...fullRead, availableBalance: 59_000_000, unavailableBalance: 32_000_000 }
    act(() => {
      store.dispatch(accountActions.setBalanceV2({ address, balance: shown as any }))
    })

    let older!: Promise<unknown>
    let newer!: Promise<unknown>
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

    expect(result.current.card.status.kind).toBe(kind)
    expect(result.current.card.balanceErrorText).toBeUndefined()
    expect(result.current.card.availableAmount).toBe(available)
    expect(splitKind(result.current.card)).toBe(kind === 'total' ? 'loading' : 'known')
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

    expect(result.current.status.kind).toBe('ready')
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
    expect(result.current.card.status.kind).toBe('loading')
    expect(result.current.card.availableAmount).toBe('--')
    expect(result.current.card.unavailableAmount).toBe('--')

    await readAgain(result)
    expect(result.current.card.status.kind).toBe('ready')
    expect(result.current.card.availableAmount).toBe('0.60000000')

    await readAgain(result)
    expect(result.current.card.availableAmount).toBe('--')
    expect(result.current.card.unavailableAmount).toBe('--')
    expect(result.current.card.balanceSplitUnknown).toBe(true)
  })

  it("does not show another network's split", () => {
    const result = renderBalanceCard({ ...overLimitSplit, chainType: ChainType.QBIT_TESTNET4 })

    // Still loading: no balance for this network has landed.
    expect(result.current.status.kind).toBe('loading')
    expect(result.current.balanceValue).toBe('--')
    expect(result.current.availableAmount).toBe('--')
    expect(result.current.unavailableAmount).toBe('--')
  })

  it("does not show another account's split", () => {
    const harness = createHookTestHarness({ wallet: walletReadingForever() as any })
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

    expect(result.current.status.kind).toBe('ready')
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

    expect(result.current.status.kind).toBe('loading')
    expect(result.current.balanceValue).toBe('--')

    act(() => {
      store.dispatch(accountActions.setBalanceV2({ address, balance }))
    })

    expect(result.current.status.kind).toBe('ready')
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

    expect(result.current.status.kind).toBe('loading')
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

    expect(result.current.status.kind).toBe('loading')
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

    expect(result.current.status.kind).toBe('ready')
    expect(result.current.balanceValue).toBe('0.00007000')
  })

  it('keeps loading when the first fetch fails, and shows the load error after a second', () => {
    const { result, store } = renderUnloadedBalanceCard()
    const chainType = ChainType.QBIT_MAINNET

    act(() => {
      store.dispatch(
        accountActions.setBalanceError({ address, requestId: 1, chainType, startedAt: Date.now() })
      )
    })
    expect(result.current.status.kind).toBe('loading')

    // The second begun 10 s after the first.
    act(() => {
      store.dispatch(
        accountActions.setBalanceError({
          address,
          requestId: 2,
          chainType,
          startedAt: Date.now() + 10_000,
        })
      )
    })
    expect(result.current.status.kind).toBe('failed-empty')
    expect(result.current.balanceValue).toBe('--')
  })
})

describe('useStartBalanceReadCallback', () => {
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
      () => ({ fetchBalance: useStartBalanceReadCallback(), card: useBalanceCardLogic() }),
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

    expect(wallet.getAddressBalanceV2).toHaveBeenCalledWith('qb1ztestaccount', {
      progressId: expect.any(String),
    })
    expect(store.getState().accounts.balanceStatusMap).toEqual({
      qb1ztestaccount: { requestId: expect.any(Number), error: true },
    })
    expect(result.current.card.status.kind).toBe('loading')
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

/**
 * The card with `getAddressBalanceV2` behind it. `loaded`: a balance read
 * before the card mounted, which it reads again at once. `shown`: a balance
 * this page read, stored once the card has mounted, so that it reads nothing
 * more at once; while it is shown, a read that brings no complete answer is
 * followed by the cadence and back-off, not by the quick reads of a card that
 * shows nothing complete.
 */
function renderPolledCard(
  getAddressBalanceV2: (readAddress: string) => Promise<unknown>,
  { loaded = false, shown = false }: { loaded?: boolean; shown?: boolean } = {}
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
    () => ({ card: useBalanceCardLogic(), fetchBalance: useStartBalanceReadCallback() }),
    { wrapper: harness.wrapper }
  )
  if (shown) {
    act(() => {
      harness.store.dispatch(accountActions.setBalanceV2({ address, balance }))
    })
  }
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
    renderPolledCard(background.getAddressBalanceV2, { shown: true })

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

  it('lets the refresh button join the read in flight: no read beside it, and the tick it missed 2 s after it lands', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const { result } = renderPolledCard(background.getAddressBalanceV2)

    // The poll's read from 10 s misses the tick at 20 s; the refresh button,
    // tapped at 22 s, joins it rather than reading beside it.
    await advance(22_000)
    act(() => result.current.card.refreshBalance())
    await advance(1_000)
    expect(background.times()).toEqual(seconds(10))
    expect(result.current.card.status).toMatchObject({ kind: 'loading', busy: true })

    await advance(7_000)
    await act(async () => {
      background.reads[0].resolve(balance)
    })
    await advance(1_999)
    expect(background.times()).toEqual(seconds(10))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 32))
    expect(background.peakOpen()).toBe(1)
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
      background.reads[0].resolve(incompleteOfShown)
    })
    // Over the balance shown when the card mounted: that balance stays,
    // dimmed as being refreshed, as after a refresh that fails.
    expect(result.current.card.status).toMatchObject({ kind: 'refreshing', reason: 'retry' })
    expect(result.current.card.balanceValue).toBe('0.00005000')
    expect(result.current.card.balanceErrorText).toBeUndefined()
    await advance(2_000)
    expect(background.times()).toEqual(seconds(0, 22))

    await advance(20_000)
    await act(async () => {
      background.reads[1].resolve(incompleteOfShown)
    })
    await advance(2_000)
    expect(background.times()).toEqual(seconds(0, 22, 44))

    await advance(4_000)
    await act(async () => {
      background.reads[2].resolve(fullRead)
    })
    expect(result.current.card.status.kind).toBe('ready')
    expect(result.current.card.availableAmount).toBe('0.60000000')
    expect(result.current.card.balanceErrorText).toBeUndefined()

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
   * Failed reads at 10 s, 2 s after it (the one quick read after the first
   * failure over a value shown), and 10 s after that, then a fourth from 42 s
   * that runs past its tick (62 s) and fails 25 s in, at 67 s: the fourth
   * failure in a row.
   */
  async function failFourthReadLate(polled: Polled, background: ReturnType<typeof recordedReads>) {
    const fail = async (index: number): Promise<void> => {
      await act(async () => {
        background.reads[index].reject(new Error('explorer unreachable'))
      })
    }
    await advance(10_000)
    await fail(0)
    await advance(2_000)
    await fail(1)
    await advance(10_000)
    await fail(2)
    await advance(20_000)
    expect(background.times()).toEqual(seconds(10, 12, 22, 42))
    await advance(25_000)
    await fail(3)
    expect(polled.result.current.card.status.kind).toBe('failed')
  }

  it('waits for the back-off after a long failed read: after the fourth failure in a row, the next read is 40 s after it ended', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const polled = renderPolledCard(background.getAddressBalanceV2, { shown: true })
    await failFourthReadLate(polled, background)

    // Neither 2 s after it failed (69 s) nor 40 s after it started (82 s):
    // 40 s after it failed.
    await advance(39_999)
    expect(background.times()).toEqual(seconds(10, 12, 22, 42))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 12, 22, 42, 107))
  })

  it.each<[string, number, number, number, number[]]>([
    // The poll's read from 10 s never answers, hidden from 15 s: stuck at
    // 70 s, and given up on as the page is shown again; with that failure
    // counted, it reads at once.
    ['shown again long after that', 0, 15, 300, seconds(10, 300)],
    ['shown again before that back-off is over', 0, 15, 75, seconds(10, 75)],
    // After four failures (a 40 s back-off) the read from 82 s never
    // answers, hidden from 85 s: stuck at 142 s.
    ['shown again long after that, past a 40 s back-off', 4, 85, 600, seconds(82, 600)],
  ])(
    'counts a read stuck while the page was hidden as failed, and reads at once as it is shown again: %s',
    async (_case, failures, hiddenAt, shownAt, reads) => {
      vi.useFakeTimers()
      const startedAt = Date.now()
      const advanceTo = (at: number): Promise<void> => advance(at - (Date.now() - startedAt))
      const background = recordedReads()
      renderPolledCard(background.getAddressBalanceV2, { shown: true })
      for (const [index, at] of seconds(10, 12, 22, 42).slice(0, failures).entries()) {
        await advanceTo(at)
        await act(async () => {
          background.reads[index].reject(new Error('explorer unreachable'))
        })
      }

      await advanceTo(hiddenAt * 1000)
      await showOrHideDocument(true)
      await advanceTo(shownAt * 1000)
      await showOrHideDocument(false)
      await advanceTo(reads[1])
      expect(background.times().slice(failures)).toEqual(reads)
    }
  )

  it('counts a read stuck while hidden, which the refresh control joined, as one failure, and the back-off from when it got stuck', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const { result } = renderPolledCard(background.getAddressBalanceV2)

    // The poll's read from 10 s never answers; a press of the refresh
    // control at 29 s joins it at 30 s. It gets stuck at 70 s while the page
    // is hidden from 35 s.
    await advance(29_000)
    act(() => result.current.card.refreshBalance())
    await advance(1_000)
    await advance(5_000)
    await showOrHideDocument(true)
    await advance(70_000)
    // Shown at 105 s: one failure, a 10 s back-off from 70 s, long over.
    await showOrHideDocument(false)
    expect(background.times()).toEqual(seconds(10, 105))
  })

  it('reads again for a press of the refresh control once the poll gives up on a read whose answer is lost', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const { result } = renderPolledCard(background.getAddressBalanceV2)

    // A press at 4 s reads at 5 s, and its answer is lost.
    await advance(4_000)
    act(() => result.current.card.refreshBalance())
    await advance(1_000)
    expect(background.times()).toEqual(seconds(5))

    // Given up on 60 s after it started, past the 30 s rule: the failure
    // shows, and a press reads at once.
    await advance(60_000)
    expect(result.current.card.status.kind).toBe('failed-empty')
    act(() => result.current.card.refreshBalance())
    expect(background.times()).toEqual(seconds(5, 65))

    // The lost answer turning up late moves nothing: once the new read
    // answers the next poll is 10 s after it started.
    await advance(1_000)
    await act(async () => {
      background.reads[0].resolve(balance)
    })
    await act(async () => {
      background.reads[1].resolve(balance)
    })
    await advance(8_999)
    expect(background.times()).toEqual(seconds(5, 65))
    await advance(1)
    expect(background.times()).toEqual(seconds(5, 65, 75))
  })

  it('reads at once, whatever the back-off, when the page is shown again with a failure counted, the failure on screen staying until that read settles (item 1)', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const polled = renderPolledCard(background.getAddressBalanceV2, { shown: true })
    await failFourthReadLate(polled, background)

    // Hidden after the failure at 67 s, shown again at 82 s, well inside the
    // back-off (until 107 s): it reads at once, and the failure shown before
    // stays, the card busy, until that read settles.
    await showOrHideDocument(true)
    await advance(15_000)
    await showOrHideDocument(false)
    expect(background.times()).toEqual(seconds(10, 12, 22, 42, 82))
    expect(polled.result.current.card.status).toMatchObject({ kind: 'failed', busy: true })
    await advance(500)
    expect(polled.result.current.card.status.kind).toBe('failed')
    await act(async () => {
      background.reads[4].resolve(balance)
    })
    await advance(400)
    expect(polled.result.current.card.status.kind).toBe('ready')
  })

  it('backs off after a failed read the refresh control joined, from when it ended', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const { result } = renderPolledCard(background.getAddressBalanceV2, { shown: true })

    // A press at 14 s joins the poll's read from 10 s at 15 s, which fails
    // at 28 s: over the balance shown, the first failure, so once more 2 s
    // after it ended; then the back-off, 10 s after that one ended.
    await advance(14_000)
    act(() => result.current.card.refreshBalance())
    await advance(14_000)
    await act(async () => {
      background.reads[0].reject(new Error('explorer unreachable'))
    })
    await advance(1_999)
    expect(background.times()).toEqual(seconds(10))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 30))
    await act(async () => {
      background.reads[1].reject(new Error('explorer unreachable'))
    })
    await advance(9_999)
    expect(background.times()).toEqual(seconds(10, 30))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 30, 40))
  })

  it('lets the refresh control read at once under the failure while a tick waits for the back-off', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const polled = renderPolledCard(background.getAddressBalanceV2, { shown: true })
    await failFourthReadLate(polled, background)

    await advance(5_000)
    expect(polled.result.current.card.status.kind).toBe('failed')
    act(() => polled.result.current.card.refreshBalance())
    expect(background.times()).toEqual(seconds(10, 12, 22, 42, 72))
    await act(async () => {
      background.reads[4].resolve(balance)
    })

    // Its success ends the back-off: one poll 10 s after it, not another at 107 s.
    await advance(9_999)
    expect(polled.result.current.card.status.kind).toBe('ready')
    expect(background.times()).toEqual(seconds(10, 12, 22, 42, 72))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 12, 22, 42, 72, 82))
  })

  it.each([
    ['a full answer', fullRead],
    ['an answer that ran out of time part of the way through', incompleteRead],
  ])(
    'backs off after answers whose read of the outputs failed, as after a rejection, until %s',
    async (_reset, resetAnswer) => {
      vi.useFakeTimers()
      let answer: unknown = failedOfShown
      const background = recordedReads(() => answer)
      const { result } = renderPolledCard(background.getAddressBalanceV2, { shown: true })

      await advance(400_000)
      // 2 s after the first failure, then 10, 20, 40 s and on up to 2 minutes.
      expect(background.times()).toEqual(seconds(10, 12, 22, 42, 82, 162, 282))
      // Over the balance shown, which stays: one refresh error.
      expect(result.current.card.status.kind).toBe('failed')
      expect(result.current.card.balanceValue).toBe('0.00005000')
      expect(result.current.card.balanceErrorText).toBe('balance_refresh_error')

      answer = resetAnswer
      await advance(25_000)
      expect(background.times().slice(7)).toEqual(seconds(402, 412, 422))
    }
  )

  it.each<[string, (read: ReturnType<typeof recordedReads>['reads'][number]) => void]>([
    ['rejects', read => read.reject(new Error('the statistics read timed out'))],
    ['answers that its read of the outputs failed', read => read.resolve(failedRead)],
  ])(
    "waits 2, 10, 20 and 40 s from each one's end after four slow reads in a row that each %s 20 s in",
    async (_how, fail) => {
      vi.useFakeTimers()
      const background = recordedReads()
      renderPolledCard(background.getAddressBalanceV2, { shown: true })
      const failAt = async (index: number): Promise<void> => {
        await advance(20_000)
        await act(async () => {
          fail(background.reads[index])
        })
      }

      await advance(10_000)
      await failAt(0)
      await advance(1_999)
      expect(background.times()).toEqual(seconds(10))
      await advance(1)
      expect(background.times()).toEqual(seconds(10, 32))

      await failAt(1)
      await advance(9_999)
      expect(background.times()).toEqual(seconds(10, 32))
      await advance(1)
      expect(background.times()).toEqual(seconds(10, 32, 62))

      await failAt(2)
      await advance(19_999)
      expect(background.times()).toEqual(seconds(10, 32, 62))
      await advance(1)
      expect(background.times()).toEqual(seconds(10, 32, 62, 102))

      await failAt(3)
      await advance(39_999)
      expect(background.times()).toEqual(seconds(10, 32, 62, 102))
      await advance(1)
      expect(background.times()).toEqual(seconds(10, 32, 62, 102, 162))
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

  it('polls 2 s after a read the refresh control joined answers, just before it would have been given up on', async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const { result } = renderPolledCard(background.getAddressBalanceV2)

    // The first poll's read from 10 s is still open when a press at 61 s
    // joins it at 62 s; it answers at 65 s, 5 s before it would have been
    // given up on.
    await advance(61_000)
    act(() => result.current.card.refreshBalance())
    await advance(4_000)
    await act(async () => {
      background.reads[0].resolve(balance)
    })

    // The ticks it missed: one read 2 s after it, at 67 s.
    await advance(1_999)
    expect(background.times()).toEqual(seconds(10))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 67))
  })

  it.each<[string, number, number | undefined, number, number]>([
    ['40 s, longer than the time left on it', 4, undefined, 142, 222],
    ['80 s, longer than the whole wait', 5, undefined, 222, 342],
    ['40 s, when the refresh control started it off the tick grid', 4, 45, 105, 185],
  ])(
    'gives up on a read 60 s after it started during a back-off of %s',
    async (_case, failures, pressedAt, givenUpAt, nextAt) => {
      vi.useFakeTimers()
      const startedAt = Date.now()
      const advanceTo = (at: number): Promise<void> => advance(at - (Date.now() - startedAt))
      const background = recordedReads()
      const polled = renderPolledCard(background.getAddressBalanceV2, { shown: true })
      // Quick failures at 10, 12, 22, 42 (and 82) s: a back-off of 40 (or 80) s.
      for (const [index, at] of seconds(10, 12, 22, 42, 82).slice(0, failures).entries()) {
        await advanceTo(at)
        await act(async () => {
          background.reads[index].reject(new Error('explorer unreachable'))
        })
      }
      if (pressedAt !== undefined) {
        // Under the failure: it reads at once.
        await advanceTo(pressedAt * 1000)
        act(() => polled.result.current.card.refreshBalance())
      }

      // The next read, the poll's or the press's, never answers: given up on
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

      // Then the reads beside it fail to read the outputs: 2, 10, 20 s
      // between them, and the last full figures stay, marked out of date.
      later = failedRead
      await advance(50_000)
      expect(background.times().slice(-3)).toEqual(seconds(322, 332, 352))
      expect(result.current.card.availableAmount).toBe('0.60000000')
      expect(result.current.card.balanceErrorText).toBe('balance_refresh_error')

      // Nearly six minutes after it started, between two ticks, it settles:
      // neither its answer nor its failure replaces the newer outcome, moves
      // the next read (40 s after the last failure, at 392 s) or counts in
      // the back-off.
      await act(async () => {
        settle(background.reads[0])
      })
      expect(result.current.card.availableAmount).toBe('0.60000000')
      expect(result.current.card.balanceErrorText).toBe('balance_refresh_error')
      await advance(31_999)
      expect(background.times().slice(-1)).toEqual(seconds(352))
      await advance(1)
      expect(background.times().slice(-1)).toEqual(seconds(392))
      await advance(80_000)
      expect(background.times().slice(-2)).toEqual(seconds(392, 472))

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
        expect(background.times()).toEqual(seconds(10, 12, 22, 42))
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
        // The quick read after it fails at once.
        await advance(2_000)
        await act(async () => {
          background.reads[1].reject(new Error('the statistics read timed out'))
        })
        await advance(3_000)
        expect(background.times()).toEqual(seconds(10, 32))
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
  // The refresh control reads at once under a failure, and after its
  // debounce otherwise, as ever.
  it.each(states)(
    'the refresh control still reads %s: at once under a failure, after its second otherwise',
    async (_state, setup, answer) => {
      vi.useFakeTimers()
      const startedAt = Date.now()
      const background = recordedReads(answer)
      const polled = renderPolledCard(background.getAddressBalanceV2, { shown: true })
      await setup(background)
      const before = background.reads.length
      const pressedAt = Date.now() - startedAt
      const { kind } = polled.result.current.card.status
      const delay = kind === 'failed' || kind === 'failed-empty' ? 0 : 1_000

      act(() => polled.result.current.card.refreshBalance())
      await advance(delay)

      expect(background.times().slice(before)).toEqual([pressedAt + delay])
    }
  )

  it.each([
    ['the refresh button', ({ result }: Polled) => result.current.card.refreshBalance(), 1_000],
  ] as const)(
    '%s joins a read held open, before the poll gives up on it, instead of reading beside it',
    async (_button, press, delay) => {
      vi.useFakeTimers()
      const background = recordedReads(() => HOLD)
      const polled = renderPolledCard(background.getAddressBalanceV2, { shown: true })
      await advance(30_000)
      expect(background.times()).toEqual(seconds(10))

      act(() => press(polled))
      await advance(delay + 500)
      expect(background.times()).toEqual(seconds(10))
      expect(background.peakOpen()).toBe(1)
      // The read in flight shows as the user's: dimmed, as being refreshed.
      expect(polled.result.current.card.status).toMatchObject({
        kind: 'refreshing',
        reason: 'user',
      })
    }
  )

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
    // Only the new account's cadence is waiting, with the card's own timer
    // that turns the ring a second before its read: nothing at 27 s.
    expect(vi.getTimerCount()).toBe(2)

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

  it('backs off after failed reads, 2, 10, 20, 40 s and on up to 2 minutes, and back to 10 s after a success', async () => {
    vi.useFakeTimers()
    let answer: unknown = new Error('explorer unreachable')
    const background = recordedReads(() => answer)

    const unhandled = await unhandledRejectionsDuring(async () => {
      const { result } = renderPolledCard(background.getAddressBalanceV2, { shown: true })

      await advance(400_000)
      expect(background.times()).toEqual(seconds(10, 12, 22, 42, 82, 162, 282))
      expect(result.current.card.status.kind).toBe('failed')

      await advance(1_999)
      expect(background.reads).toHaveLength(7)
      answer = balance
      await advance(1)
      expect(background.times().slice(7)).toEqual(seconds(402))
      await advance(400)
      expect(result.current.card.status.kind).toBe('ready')

      await advance(19_600)
      expect(background.times().slice(7)).toEqual(seconds(402, 412, 422))
    })
    // Every failed read was handled, by the card's poll or its status.
    expect(unhandled).toEqual([])
  })

  it('keeps the normal cadence while the answers are incomplete, after a back-off too', async () => {
    vi.useFakeTimers()
    let answer: unknown = new Error('explorer unreachable')
    const background = recordedReads(() => answer)
    const { result } = renderPolledCard(background.getAddressBalanceV2, { shown: true })

    await advance(40_000)
    expect(background.times()).toEqual(seconds(10, 12, 22))

    // Three failures, the last 10 s and more after the first: the failure shows.
    expect(result.current.card.status.kind).toBe('failed')

    // The background read the statistics, and makes progress through the
    // outputs with every read: that is no failure to back off from, and the
    // explorer is answering, so the failure no longer shows.
    answer = incompleteOfShown
    await advance(5_000)
    expect(background.times()).toEqual(seconds(10, 12, 22, 42))
    expect(result.current.card.status).toMatchObject({ kind: 'refreshing', reason: 'retry' })
    await advance(30_000)
    expect(background.times()).toEqual(seconds(10, 12, 22, 42, 52, 62, 72))

    answer = fullRead
    await advance(20_000)
    expect(background.times()).toEqual(seconds(10, 12, 22, 42, 52, 62, 72, 82, 92))
    expect(result.current.card.status.kind).toBe('ready')
    expect(result.current.card.availableAmount).toBe('0.60000000')
  })

  // Over a balance already shown, an answer that could not read every output
  // is recorded as a failed refresh; the poll paces itself by the answer.
  const laterFull = {
    ...fullRead,
    availableBalance: 62_000_000,
    unavailableBalance: 30_000_000,
    totalBalance: 92_000_000,
  }

  it('backs off after answers whose read of the outputs failed over a balance already shown, which keeps its figures, marked out of date', async () => {
    vi.useFakeTimers()
    let answer: unknown = fullRead
    const background = recordedReads(() => answer)
    const { result } = renderPolledCard(background.getAddressBalanceV2)

    await advance(10_000)
    expect(result.current.card.availableAmount).toBe('0.60000000')

    answer = failedRead
    await advance(400_000)
    // 10 s after the full read, then 2, 10, 20, 40 s and on up to 2 minutes.
    expect(background.times()).toEqual(seconds(10, 20, 22, 32, 52, 92, 172, 292))
    expect(result.current.card.balanceValue).toBe('0.91000000')
    expect(result.current.card.availableAmount).toBe('0.60000000')
    expect(result.current.card.unavailableAmount).toBe('0.31000000')
    expect(result.current.card.balanceErrorText).toBe('balance_refresh_error')
    expect(result.current.card.status.kind).toBe('failed')

    // A full answer ends the back-off, and the warning.
    answer = laterFull
    await advance(3_000)
    expect(background.times().slice(8)).toEqual(seconds(412))
    expect(result.current.card.balanceErrorText).toBeUndefined()
    expect(result.current.card.availableAmount).toBe('0.62000000')
    await advance(10_000)
    expect(background.times().slice(8)).toEqual(seconds(412, 422))
  })

  it('keeps its pace on answers that ran out of time part of the way through over a balance already shown, which keeps its figures, dimmed as being refreshed', async () => {
    vi.useFakeTimers()
    let answer: unknown = fullRead
    const background = recordedReads(() => answer)
    const { result } = renderPolledCard(background.getAddressBalanceV2)

    await advance(10_000)
    answer = incompleteRead
    await advance(40_000)
    expect(background.times()).toEqual(seconds(10, 20, 30, 40, 50))
    expect(result.current.card.availableAmount).toBe('0.60000000')
    // Progress, not failure: the figures stay, dimmed as being refreshed.
    expect(result.current.card.status).toMatchObject({ kind: 'refreshing', reason: 'retry' })
    expect(result.current.card.balanceErrorText).toBeUndefined()

    answer = laterFull
    await advance(10_000)
    expect(background.times()).toEqual(seconds(10, 20, 30, 40, 50, 60))
    expect(result.current.card.balanceErrorText).toBeUndefined()
    expect(result.current.card.availableAmount).toBe('0.62000000')
  })

  it.each<[string, (card: Polled) => void, number]>([
    ['the refresh control reads at once', ({ result }) => result.current.card.refreshBalance(), 0],
  ])(
    '%s under the failure during a back-off, and its success brings the poll back to 10 s',
    async (_case, refresh, delay) => {
      vi.useFakeTimers()
      let answer: unknown = new Error('explorer unreachable')
      const background = recordedReads(() => answer)
      const polled = renderPolledCard(background.getAddressBalanceV2, { shown: true })

      // Four failures: the next poll would be 40 s after the last, at 82 s.
      // The failure shows, dimmed, from the third.
      await advance(40_000)
      expect(polled.result.current.card.status.kind).toBe('failed')
      await advance(10_000)
      expect(background.times()).toEqual(seconds(10, 12, 22, 42))

      answer = balance
      act(() => refresh(polled))
      await advance(delay)
      expect(background.times()).toEqual([...seconds(10, 12, 22, 42), 50_000 + delay])
      expect(polled.result.current.card.status.kind).toBe('ready')

      await advance(10_000)
      expect(background.times()).toEqual([
        ...seconds(10, 12, 22, 42),
        50_000 + delay,
        60_000 + delay,
      ])
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
    const { selectAccount, result } = renderPolledCard(background.getAddressBalanceV2, {
      shown: true,
    })

    // The first account fails three times (the next poll would be 20 s
    // later), and its fourth read is still in flight.
    await advance(10_000)
    await act(async () => {
      background.reads[0].reject(new Error('explorer unreachable'))
    })
    await advance(2_000)
    await act(async () => {
      background.reads[1].reject(new Error('explorer unreachable'))
    })
    await advance(10_000)
    await act(async () => {
      background.reads[2].reject(new Error('explorer unreachable'))
    })
    await advance(20_000)
    expect(background.times()).toEqual(seconds(10, 12, 22, 42))

    await advance(2_000)
    selectAccount('qbit-another-account')
    // Ten seconds on, not twenty, and not skipped for the old account's read.
    await advance(9_999)
    expect(background.reads).toHaveLength(4)
    await advance(1)
    expect(background.reads.map(read => read.address)).toEqual([
      address,
      address,
      address,
      address,
      'qbit-another-account',
    ])
    expect(background.times()[4]).toBe(54_000)

    // The old account's read failing later does not back the new one off.
    await act(async () => {
      background.reads[3].reject(new Error('explorer unreachable'))
      background.reads[4].resolve({ ...balance, totalBalance: 7_000, availableBalance: 7_000 })
    })
    await advance(10_000)
    expect(background.times().slice(4)).toEqual(seconds(54, 64))
    expect(background.reads.slice(4).map(read => read.address)).toEqual([
      'qbit-another-account',
      'qbit-another-account',
    ])
    expect(result.current.card.balanceValue).toBe('0.00007000')
  })

  it("starts a new network from a clean cadence, and never reads the previous network's address on it", async () => {
    vi.useFakeTimers()
    let answer: unknown = new Error('explorer unreachable')
    const background = recordedReads(() => answer)
    const { store, selectAccount } = renderPolledCard(background.getAddressBalanceV2, {
      shown: true,
    })

    // Five failures: the next poll would be 80 s after the last, at 162 s.
    await advance(80_000)
    expect(background.times()).toEqual(seconds(10, 12, 22, 42))
    await advance(2_000)
    expect(background.times()).toEqual(seconds(10, 12, 22, 42, 82))

    answer = { ...balance, chainType: ChainType.QBIT_TESTNET4 }
    await advance(5_000)
    // The network changes first; the account follows a moment later, as the
    // account updater reloads it: nothing reads the old address meanwhile.
    act(() => {
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })
    await advance(500)
    expect(background.reads).toHaveLength(5)
    selectAccount('tq1-the-account-on-testnet')
    // Not read before on this page: the account updater's read is the first
    // (none here), else the new cadence's first tick, 10 s on.
    await advance(9_999)
    expect(background.reads).toHaveLength(5)
    await advance(1)
    expect(background.reads.slice(5).map(read => [read.address, read.at])).toEqual([
      ['tq1-the-account-on-testnet', 97_500],
    ])
  })

  it("reads a new account for a press of the refresh control while the old account's read is still out", async () => {
    vi.useFakeTimers()
    const background = recordedReads()
    const { result, selectAccount } = renderPolledCard(background.getAddressBalanceV2)

    act(() => result.current.card.refreshBalance())
    await advance(1_000)
    expect(background.reads.map(read => read.address)).toEqual([address])

    selectAccount('qbit-another-account')
    act(() => result.current.card.refreshBalance())
    await advance(1_000)
    expect(background.reads.map(read => read.address)).toEqual([address, 'qbit-another-account'])
    // The old account's read ending changes nothing of the new one's.
    await act(async () => {
      background.reads[0].reject(new Error('explorer unreachable'))
    })
    expect(result.current.card.status).toMatchObject({ kind: 'loading', busy: true })
    await act(async () => {
      background.reads[1].resolve(balance)
    })
    expect(result.current.card.status.kind).toBe('ready')
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
    // A poll timer, the card's own timer for the ring a second before that
    // read, and the refresh button's debounce are waiting, and the read on
    // mounting is still in flight.
    expect(vi.getTimerCount()).toBe(3)
    // The two polls' (the second for the new account) and the card's own,
    // which notes when the page is hidden.
    expect(added).toHaveLength(3)

    unmount()

    expect(vi.getTimerCount()).toBe(0)
    // Every one removed, whatever the order.
    expect(removed).toHaveLength(added.length)
    expect(new Set(removed)).toEqual(new Set(added))
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
    expect(result.current.card.status.kind).toBe('ready')
    expect(result.current.card.availableAmount).toBe('0.60000000')
  })
})

describe('useBalanceCardLogic when an older read brings the split after a newer one could not read every output', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // Read later, with a total that moved since.
  const newerIncomplete = {
    ...incompleteRead,
    unavailableBalance: 92_000_000,
    totalBalance: 92_000_000,
  }
  const laterFull = {
    ...fullRead,
    availableBalance: 62_000_000,
    unavailableBalance: 30_000_000,
    totalBalance: 92_000_000,
  }

  // Its split, dimmed as being refreshed, while the newer read's total is
  // the same; else the newer read's total, its split loading.
  const olderSplitShown = (card: ReturnType<typeof useBalanceCardLogic>): void => {
    expect(card.balanceValue).toBe('0.91000000')
    expect(card.availableAmount).toBe('0.60000000')
    expect(card.unavailableAmount).toBe('0.31000000')
    expect(card.status).toMatchObject({ kind: 'refreshing', reason: 'retry' })
  }
  const newerTotalShown = (card: ReturnType<typeof useBalanceCardLogic>): void => {
    expect(card.balanceValue).toBe('0.92000000')
    expect(card.availableAmount).toBe('--')
    expect(card.unavailableAmount).toBe('--')
    expect(card.status.kind).toBe('total')
  }

  it.each<[string, unknown, (card: ReturnType<typeof useBalanceCardLogic>) => void]>([
    ['ran out of time part of the way through', incompleteRead, olderSplitShown],
    ['failed', failedRead, olderSplitShown],
    [
      'ran out of time part of the way through, with a total that moved',
      newerIncomplete,
      newerTotalShown,
    ],
    [
      'failed, with a total that moved',
      { ...newerIncomplete, utxoReadFailed: true },
      newerTotalShown,
    ],
  ])(
    "shows the split of the account updater's read when it lands after the card's newer read %s, with no split shown before, as long as the totals agree",
    async (_how, answer, expectShown) => {
      vi.useFakeTimers()
      const background = recordedReads()
      const { result } = renderPolledCard(background.getAddressBalanceV2)

      // The account updater's read of a cold account (request 1) is still
      // out when the card's poll reads (request 2).
      let updaterRead!: Promise<unknown>
      act(() => {
        updaterRead = result.current.fetchBalance()
      })
      await advance(10_000)
      expect(background.times()).toEqual(seconds(0, 10))

      // The poll's read answers first, without every output: the total,
      // the split loading.
      await act(async () => {
        background.reads[1].resolve(answer)
      })
      expect(result.current.card.balanceValue).toBe(
        (answer as { totalBalance: number }).totalBalance === 92_000_000
          ? '0.92000000'
          : '0.91000000'
      )
      expect(result.current.card.availableAmount).toBe('--')
      expect(result.current.card.status.kind).toBe('total')
      expect(result.current.card.balanceErrorText).toBeUndefined()

      // The updater's read then answers in full: its split shows, dimmed as
      // being refreshed, since the newer read did not answer in full, unless
      // the newer read's total differs from it.
      await act(async () => {
        background.reads[0].resolve(fullRead)
        await updaterRead
      })
      expectShown(result.current.card)
      expect(result.current.card.balanceErrorText).toBeUndefined()

      // A press of the refresh control reads after its second, and a full
      // answer ends the refresh.
      act(() => {
        result.current.card.refreshBalance()
      })
      await advance(1_000)
      expect(background.times()).toEqual(seconds(0, 10, 11))
      await act(async () => {
        background.reads[2].resolve(laterFull)
      })
      expect(result.current.card.balanceErrorText).toBeUndefined()
      expect(result.current.card.balanceValue).toBe('0.92000000')
      expect(result.current.card.availableAmount).toBe('0.62000000')
    }
  )
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

  it('lets a caller join a read it holds, the join ending as the read does or as the poll gives up on it (item 4)', async () => {
    vi.useFakeTimers()
    const background = pendingBalanceReads()
    const reads: Promise<unknown>[] = []
    const balancePoll = startBalancePoll(() => {
      const reading = background.fetchBalance()
      reads.push(reading)
      return reading
    })

    const unhandled = await unhandledRejectionsDuring(async () => {
      const first = outcomeOf(balancePoll.read())
      const joined = balancePoll.join(reads[0]!)
      expect(joined).toBeDefined()
      // A read it does not hold has no join.
      expect(balancePoll.join(Promise.resolve())).toBeUndefined()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(await outcomeOf(joined!)).toBe(
        'BalanceReadGaveUpError: balance read gave up after 60 s'
      )
      expect(await first).toBe('BalanceReadGaveUpError: balance read gave up after 60 s')
      // Its answer, when it comes, reaches no one.
      background.reads[0].resolve(fullRead)
      balancePoll.stop()
    })
    expect(unhandled).toEqual([])
  })

  it('tells its caller each time its schedule changes, once the change is made (round 4, item 3)', async () => {
    vi.useFakeTimers()
    const start = Date.now()
    const background = pendingBalanceReads()
    // When the next read is due, as the poll says at each notice.
    const notices: Array<number | undefined> = []
    const ref: { poll?: ReturnType<typeof startBalancePoll> } = {}
    ref.poll = startBalancePoll(background.fetchBalance, {
      onScheduleChange: () => {
        if (ref.poll) notices.push(ref.poll.nextReadAt())
      },
    })
    const due = (...at: Array<number | undefined>) =>
      at.map(value => (value === undefined ? undefined : start + value))

    // A read begins at 10 s, and answers: the next is due at 20 s.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(notices).toEqual(due(undefined))
    background.reads[0].resolve(fullRead)
    await vi.advanceTimersByTimeAsync(0)
    expect(notices).toEqual(due(undefined, 20_000))
    // A read at 12 s still in flight at 22 s, when a tick falls due, answers
    // at 25 s: the tick missed is due 2 s later, at 27 s.
    await vi.advanceTimersByTimeAsync(2_000)
    ref.poll.read().catch(() => undefined)
    await vi.advanceTimersByTimeAsync(13_000)
    background.reads[1].resolve(fullRead)
    await vi.advanceTimersByTimeAsync(0)
    expect(notices).toEqual(due(undefined, 20_000, undefined, undefined, 27_000))
    expect(ref.poll.nextReadAt()).toBe(start + 27_000)
    ref.poll.stop()
  })

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
