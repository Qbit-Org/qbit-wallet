import { act, render, renderHook } from '@testing-library/react'
import React, { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QBIT_BALANCE_READ_PROGRESS } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import {
  useFetchBalanceCallback,
  useReloadAccounts,
  useStartBalanceReadCallback,
} from '../../src/hooks/accounts'
import {
  balanceCardFor,
  balanceReadInFlight,
  noteBalanceReadInFlight,
} from '../../src/hooks/balanceReads'
import { settingsActions } from '../../src/reducers/settings'
import { useCurrentAccountBalanceTotal } from '../../src/hooks/accountTotals'
import { I18nContext } from '../../src/context/I18nContext'

const defaultI18n = {
  supportedLocales: ['en'],
  localeNames: {},
  changeLocale: async () => undefined,
  isSpecialLocale: false,
}
import { accountActions, accountsReloaded } from '../../src/reducers/accounts'
import { globalActions } from '../../src/reducers/global'
import { useBalanceCardLogic } from '../../src/ui-hooks/useBalanceCardLogic'
import { AccountUpdater } from '../../src/updater/accounts'
import { uiEventBus } from '../../src/utils/eventBus'
import { createHookTestHarness, createWalletMock } from './testHelpers'

const address = 'qbit-open-account'
const complete = {
  availableBalance: 60_000_000,
  unavailableBalance: 31_000_000,
  totalBalance: 91_000_000,
  immatureBalance: 0,
  pendingBalance: 31_000_000,
  chainType: ChainType.QBIT_MAINNET,
}
const incomplete = {
  availableBalance: null,
  unavailableBalance: 92_000_000,
  totalBalance: 92_000_000,
  immatureBalance: null,
  pendingBalance: null,
  utxoReadIncomplete: true,
  chainType: ChainType.QBIT_MAINNET,
}

interface Read {
  address: string
  at: number
  progressId?: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** A background whose reads answer when the test says, each noted with when it began (ms since the start). */
function heldReads() {
  const startedAt = Date.now()
  const reads: Read[] = []
  // A plain function, not a vi.fn: a spy would handle every rejection itself.
  const getAddressBalanceV2 = (readAddress: string, options?: { progressId?: string }) =>
    new Promise((resolve, reject) => {
      reads.push({
        address: readAddress,
        at: Date.now() - startedAt,
        progressId: options?.progressId,
        resolve,
        reject,
      })
    })
  return { reads, getAddressBalanceV2, times: () => reads.map(read => read.at) }
}

function harnessFor(
  getAddressBalanceV2: (...args: any[]) => Promise<unknown>,
  more: Record<string, unknown> = {}
) {
  const wallet = {
    ...createWalletMock(),
    ...more,
    getAddressBalanceV2,
    // reloadAccounts runs as the account is selected; keep it from replacing it.
    getKeyrings: vi.fn(() => new Promise<never>(() => undefined)),
  }
  const harness = createHookTestHarness({ wallet: wallet as any })
  harness.store.dispatch(globalActions.update({ isUnlocked: true }))
  harness.store.dispatch(
    accountActions.setCurrent({
      address,
      key: 'account-1',
      pubkey: '11'.repeat(32),
      type: 'Qbit HD Key Tree',
    } as any)
  )
  return harness
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const seconds = (...values: number[]): number[] => values.map(value => value * 1000)

afterEach(() => {
  vi.useRealTimers()
  delete (document as { hidden?: boolean }).hidden
})

describe('the read at open (S1)', () => {
  it.each([
    ['the account updater begins first', 'updater-first'],
    ['the card begins first', 'card-first'],
  ])('reads the selected account once, and that read is the card’s: %s', async (_order, order) => {
    vi.useFakeTimers()
    const background = heldReads()
    const harness = harnessFor(background.getAddressBalanceV2)
    const { result } = renderHook(
      () => {
        if (order === 'updater-first') {
          AccountUpdater()
          return useBalanceCardLogic()
        }
        const card = useBalanceCardLogic()
        AccountUpdater()
        return card
      },
      { wrapper: harness.wrapper }
    )

    expect(background.times()).toEqual([0])
    expect(result.current.status.kind).toBe('loading')
    // It fails: the card reads again 1.5 s later, as after its own read.
    await act(async () => {
      background.reads[0].reject(new Error('explorer unreachable'))
    })
    await advance(1_499)
    expect(background.reads).toHaveLength(1)
    await advance(1)
    expect(background.times()).toEqual([0, 1_500])
  })

  it('reads a newly selected account once while the card is shown', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const harness = harnessFor(background.getAddressBalanceV2)
    renderHook(
      () => {
        AccountUpdater()
        return useBalanceCardLogic()
      },
      { wrapper: harness.wrapper }
    )
    await act(async () => {
      background.reads[0].resolve(complete)
    })

    act(() => {
      harness.store.dispatch(
        accountActions.setCurrent({ address: 'qbit-second-account', key: 'account-2' } as any)
      )
    })
    expect(background.reads.map(read => read.address)).toEqual([address, 'qbit-second-account'])
    // Nothing else reads it until the card's poll is due.
    await advance(9_999)
    expect(background.reads).toHaveLength(2)
  })

  describe('at an unlock in the page', () => {
    /** The account updater, and the home screen's card once `card` says so, the wallet locked. */
    function renderLocked(getAddressBalanceV2: (...args: any[]) => Promise<unknown>) {
      const harness = harnessFor(getAddressBalanceV2)
      harness.store.dispatch(globalActions.update({ isUnlocked: false }))
      const Updater = (): null => {
        AccountUpdater()
        return null
      }
      const Card = (): null => {
        useBalanceCardLogic()
        return null
      }
      const tree = (card: boolean) =>
        createElement(
          harness.wrapper,
          null,
          createElement(Updater),
          card ? createElement(Card) : null
        )
      const view = render(tree(false))
      return {
        unlock: () =>
          act(() => {
            harness.store.dispatch(globalActions.update({ isUnlocked: true }))
          }),
        showCard: () => act(() => view.rerender(tree(true))),
      }
    }

    it('reads once when the home screen shows while the read is in flight, and next an interval after it began', async () => {
      vi.useFakeTimers()
      const background = heldReads()
      const page = renderLocked(background.getAddressBalanceV2)
      expect(background.reads).toHaveLength(0)

      page.unlock()
      await advance(300)
      page.showCard()
      await act(async () => {
        background.reads[0].resolve(complete)
      })
      await advance(9_699)
      expect(background.times()).toEqual([0])
      await advance(1)
      expect(background.times()).toEqual([0, 10_000])
    })

    it('reads once when the read answered just before the home screen shows, and next an interval after it began', async () => {
      vi.useFakeTimers()
      const background = heldReads()
      const page = renderLocked(background.getAddressBalanceV2)

      page.unlock()
      await advance(400)
      await act(async () => {
        background.reads[0].resolve(complete)
      })
      await advance(400)
      page.showCard()
      expect(background.times()).toEqual([0])
      await advance(9_199)
      expect(background.times()).toEqual([0])
      await advance(1)
      expect(background.times()).toEqual([0, 10_000])
    })

    it('reads again at once when the home screen shows longer after the last read', async () => {
      vi.useFakeTimers()
      const background = heldReads()
      const page = renderLocked(background.getAddressBalanceV2)

      page.unlock()
      await act(async () => {
        background.reads[0].resolve(complete)
      })
      await advance(2_000)
      page.showCard()
      expect(background.times()).toEqual([0, 2_000])
    })
  })

  it('reads the account on a screen without the card', () => {
    const background = heldReads()
    const harness = harnessFor(background.getAddressBalanceV2)
    renderHook(() => AccountUpdater(), { wrapper: harness.wrapper })
    expect(background.reads.map(read => read.address)).toEqual([address])
  })
})

/** The card alone, with no balance read yet: its poll reads first 10 s after it mounts. */
function renderCard(getAddressBalanceV2: (...args: any[]) => Promise<unknown>) {
  const harness = harnessFor(getAddressBalanceV2)
  const view = renderHook(
    () => ({
      card: useBalanceCardLogic(),
      fetchBalance: useFetchBalanceCallback(),
      startRead: useStartBalanceReadCallback(),
    }),
    { wrapper: harness.wrapper }
  )
  return { ...harness, ...view }
}

describe('reading again while nothing complete is shown (S2)', () => {
  it('reads 1.5, 3 and 6 s after each failed read, then backs off from 10 s', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    renderCard(background.getAddressBalanceV2)

    for (let index = 0; index < 6; index += 1) {
      await advance(index === 0 ? 10_000 : 0)
      // Each read fails as soon as it begins.
      while (background.reads.length <= index) await advance(500)
      await act(async () => {
        background.reads[index].reject(new Error('explorer unreachable'))
      })
    }
    expect(background.times()).toEqual(seconds(10, 11.5, 14.5, 20.5, 30.5, 50.5))
  })

  it('reads 1.5, 3 and 6 s after each incomplete answer, then every 10 s from the last start', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    renderCard(background.getAddressBalanceV2)

    await advance(10_000)
    for (let index = 0; index < 6; index += 1) {
      while (background.reads.length <= index) await advance(500)
      await act(async () => {
        background.reads[index].resolve(incomplete)
      })
    }
    expect(background.times()).toEqual(seconds(10, 11.5, 14.5, 20.5, 30.5, 40.5))
  })

  it('follows a first failure with one read 2 s later, then the back-off, not the quick reads, while a complete answer is shown (item 4)', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    renderCard(background.getAddressBalanceV2)

    await advance(10_000)
    await act(async () => {
      background.reads[0].resolve(complete)
    })
    await advance(10_000)
    await act(async () => {
      background.reads[1].reject(new Error('explorer unreachable'))
    })
    await advance(1_999)
    expect(background.times()).toEqual(seconds(10, 20))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 20, 22))
    await act(async () => {
      background.reads[2].reject(new Error('explorer unreachable'))
    })
    await advance(9_999)
    expect(background.times()).toEqual(seconds(10, 20, 22))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 20, 22, 32))
  })

  it('reads nothing while hidden after a read fails, and at once when shown again', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    renderCard(background.getAddressBalanceV2)

    await advance(10_000)
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await act(async () => {
      background.reads[0].reject(new Error('explorer unreachable'))
    })
    await advance(30_000)
    expect(background.times()).toEqual(seconds(10))

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(background.times()).toEqual(seconds(10, 40))
  })

  it('lets the refresh control read during a quick wait, and goes on with the next quick read after it', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const { result } = renderCard(background.getAddressBalanceV2)

    await advance(10_000)
    await act(async () => {
      background.reads[0].reject(new Error('explorer unreachable'))
    })
    // The quick read is due at 11.5 s; the user presses at 10 s, which
    // reads a second later.
    act(() => result.current.card.refreshBalance())
    await advance(1_000)
    expect(background.times()).toEqual(seconds(10, 11))
    await act(async () => {
      background.reads[1].reject(new Error('explorer unreachable'))
    })
    // Not beside it at 11.5 s: 3 s after it ended.
    await advance(2_999)
    expect(background.times()).toEqual(seconds(10, 11))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 11, 14))
  })
})

describe('escalating by the clock (S4)', () => {
  it('shows the load error 30 s after the first failed read began, with no other event', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const { result } = renderCard(background.getAddressBalanceV2)

    await advance(10_000)
    await act(async () => {
      background.reads[0].reject(new Error('explorer unreachable'))
    })
    // The quick read from 11.5 s never answers.
    await advance(29_999)
    expect(background.times()).toEqual(seconds(10, 11.5))
    expect(result.current.card.status.kind).toBe('loading')
    await advance(1)
    expect(result.current.card.status).toMatchObject({ kind: 'failed-empty', busy: true })
    expect(result.current.card.balanceErrorText).toBe('balance_load_error')
  })
})

describe('progress events of a read', () => {
  it("records only this page's read in flight that asked for them", async () => {
    const background = heldReads()
    const { result, store } = renderCard(background.getAddressBalanceV2)
    let reading!: Promise<unknown>
    act(() => {
      reading = result.current.fetchBalance()
    })
    const { progressId } = background.reads[0]
    expect(progressId).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    const emit = (event: object) =>
      act(() => {
        uiEventBus.emit(QBIT_BALANCE_READ_PROGRESS, event)
      })
    const early = () => store.getState().accounts.balanceReadMap[address]?.early

    // Another page's read, another account, and no count at all: nothing.
    emit({
      progressId: 'another-page',
      kind: 'total',
      address,
      chainType: ChainType.QBIT_MAINNET,
      totalBalance: 1,
    })
    emit({
      progressId,
      kind: 'total',
      address: 'qbit-other',
      chainType: ChainType.QBIT_MAINNET,
      totalBalance: 1,
    })
    emit({
      progressId,
      kind: 'outputs',
      address,
      chainType: ChainType.QBIT_MAINNET,
      read: 3,
      total: 2,
    })
    expect(early()).toBeUndefined()

    emit({
      progressId,
      kind: 'total',
      address,
      chainType: ChainType.QBIT_MAINNET,
      totalBalance: 92_000_000,
    })
    expect(early()).toMatchObject({ totalBalance: 92_000_000 })
    expect(result.current.card.status).toMatchObject({
      kind: 'total',
      shown: { total: 92_000_000 },
    })

    // Once it answered, its events name no read here.
    await act(async () => {
      background.reads[0].resolve(complete)
      await reading
    })
    emit({
      progressId,
      kind: 'outputs',
      address,
      chainType: ChainType.QBIT_MAINNET,
      read: 1,
      total: 2,
    })
    expect(early()).toBeUndefined()
    expect(result.current.card.status.kind).toBe('ready')
  })
})

describe('one read of the account at a time (item 5)', () => {
  it('runs a refresh from elsewhere after the read in flight, never beside it, and once for every caller meanwhile', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const { result } = renderCard(background.getAddressBalanceV2)
    // The card's poll reads at 10 s.
    await advance(10_000)
    expect(background.times()).toEqual(seconds(10))

    // Three refreshes after a broadcast, while the poll's read is in flight.
    let refreshes!: Promise<unknown>[]
    act(() => {
      refreshes = [
        result.current.fetchBalance(),
        result.current.fetchBalance(),
        result.current.fetchBalance(),
      ]
    })
    await advance(2_000)
    expect(background.times()).toEqual(seconds(10))

    await act(async () => {
      background.reads[0].resolve(complete)
    })
    // One read, as soon as the one in flight settled, through the card's poll.
    expect(background.times()).toEqual(seconds(10, 12))
    await act(async () => {
      background.reads[1].resolve({
        ...complete,
        totalBalance: 92_000_000,
        availableBalance: 61_000_000,
      })
    })
    const answers = await Promise.all(refreshes)
    expect(answers.map(answer => (answer as typeof complete).totalBalance)).toEqual([
      92_000_000, 92_000_000, 92_000_000,
    ])
  })

  it('reads at once when nothing is in flight', async () => {
    const background = heldReads()
    const { result } = renderCard(background.getAddressBalanceV2)
    act(() => {
      // Its caller handles its outcome, as every caller does.
      result.current.fetchBalance().catch(() => undefined)
    })
    expect(background.reads).toHaveLength(1)
  })
})

describe('the registry of reads in flight (V10)', () => {
  it('keeps the newer read noted in flight when an older one settles', async () => {
    const store = {}
    const settle: Array<() => void> = []
    const read = (requestId: number) => ({
      requestId,
      startedAt: requestId,
      chainType: ChainType.QBIT_MAINNET,
      reading: new Promise<undefined>(resolve => settle.push(() => resolve(undefined))),
    })
    const older = read(1)
    const newer = read(2)
    noteBalanceReadInFlight(store, address, older)
    noteBalanceReadInFlight(store, address, newer)
    settle[0]!()
    await older.reading
    expect(balanceReadInFlight(store, address)).toBe(newer)
    settle[1]!()
    await newer.reading
    expect(balanceReadInFlight(store, address)).toBeUndefined()
  })
})

describe('a read the card gave up on (item 7)', () => {
  it('is no longer in flight: a press of the refresh control reads anew, and its progress is no longer recorded', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const { result, store } = renderCard(background.getAddressBalanceV2)
    await advance(10_000)
    const { progressId } = background.reads[0]!
    // Given up on 60 s after it began.
    await advance(60_000)
    expect(store.getState().accounts.balanceReadMap[address]?.failed?.reads).toEqual([
      { requestId: expect.any(Number), startedAt: expect.any(Number) },
    ])
    act(() => {
      uiEventBus.emit(QBIT_BALANCE_READ_PROGRESS, {
        progressId,
        kind: 'total',
        address,
        chainType: ChainType.QBIT_MAINNET,
        totalBalance: 1,
      })
    })
    expect(store.getState().accounts.balanceReadMap[address]?.early).toBeUndefined()
    const before = background.reads.length
    // Under the failure the press reads at once.
    expect(result.current.card.status.kind).toBe('failed-empty')
    act(() => result.current.card.refreshBalance())
    expect(background.reads).toHaveLength(before + 1)
  })
})

describe('a read that never answers holds nothing up (items 4 and 5)', () => {
  it('leaves the refresh control free once the card gives up on a read a press joined: the ring stops, and a press reads (N4)', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const { result } = renderCard(background.getAddressBalanceV2)
    await advance(10_000)
    act(() => result.current.card.refreshBalance())
    await advance(1_000)
    // Joined: no second read, and the card says it is busy.
    expect(background.reads).toHaveLength(1)
    expect(result.current.card.status.busy).toBe(true)
    // Given up on 60 s after it began, at 70 s.
    await advance(58_999)
    expect(result.current.card.status.busy).toBe(true)
    await advance(1)
    expect(result.current.card.status).toMatchObject({ kind: 'failed-empty', busy: false })
    act(() => result.current.card.refreshBalance())
    expect(background.times()).toEqual(seconds(10, 70))
  })

  it('begins a refresh queued behind it once the card gives up on it, and lets later ones run (N5)', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const { result } = renderCard(background.getAddressBalanceV2)
    await advance(10_000)
    let first!: Promise<unknown>
    act(() => {
      first = result.current.fetchBalance()
    })
    await advance(59_999)
    expect(background.times()).toEqual(seconds(10))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 70))
    await act(async () => {
      background.reads[1]!.resolve(complete)
    })
    await expect(first).resolves.toEqual(complete)
    // A refresh asked for while the poll's next read is in flight runs after it.
    await advance(10_000)
    expect(background.times()).toEqual(seconds(10, 70, 80))
    let second!: Promise<unknown>
    act(() => {
      second = result.current.fetchBalance()
    })
    await act(async () => {
      background.reads[2]!.resolve(complete)
    })
    expect(background.times()).toEqual(seconds(10, 70, 80, 80))
    await act(async () => {
      background.reads[3]!.resolve(complete)
    })
    await expect(second).resolves.toEqual(complete)
  })
})

describe('the shortcut at an unlock in the page (item 9, V12, V13)', () => {
  /** The account updater alone, unlocked: its read; then the card, `after` ms later. */
  async function cardAfterUpdaterRead(
    answer: unknown,
    after: number,
    change?: (store: ReturnType<typeof harnessFor>['store']) => void
  ) {
    vi.useFakeTimers()
    const background = heldReads()
    const harness = harnessFor(background.getAddressBalanceV2)
    const Updater = (): null => {
      AccountUpdater()
      return null
    }
    const Card = (): null => {
      useBalanceCardLogic()
      return null
    }
    const tree = (card: boolean) =>
      createElement(
        harness.wrapper,
        null,
        createElement(Updater),
        card ? createElement(Card) : null
      )
    const view = render(tree(false))
    await act(async () => {
      if (answer instanceof Error) background.reads[0]!.reject(answer)
      else background.reads[0]!.resolve(answer)
    })
    change?.(harness.store)
    await advance(after)
    act(() => view.rerender(tree(true)))
    return background
  }

  it('takes the read as the card first only when that read brought the complete answer', async () => {
    expect((await cardAfterUpdaterRead(complete, 500)).times()).toEqual([0])
  })

  it('reads at once when that read failed (V12)', async () => {
    expect((await cardAfterUpdaterRead(new Error('explorer down'), 500)).times()).toEqual([0, 500])
  })

  it('reads at once when the complete answer stored is not that read’s (item 9)', async () => {
    const background = await cardAfterUpdaterRead(new Error('explorer down'), 500, store => {
      // A complete answer of an older read stored for the account.
      store.dispatch(
        accountActions.setBalanceV2({ address, balance: complete as never, requestId: -5 })
      )
    })
    expect(background.times()).toEqual([0, 500])
  })

  it('reads at once when that read began while the page showed another network (V13)', async () => {
    // The page asked on mainnet; the background had switched to testnet and
    // answered for it; then the page switched too, the address the same.
    const background = await cardAfterUpdaterRead(
      { ...complete, chainType: ChainType.QBIT_TESTNET4 },
      500,
      store => {
        // The account's own address on the testnet is the same: no wait for
        // the new network's account.
        store.dispatch(
          accountActions.setCurrent({
            address,
            key: 'account-1',
            pubkey: '11'.repeat(32),
            type: 'Qbit HD Key Tree',
            p2mr: {
              addresses: { mainnet: address, testnet4: address, signet: address, regtest: 'r' },
            },
          } as never)
        )
        store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
      }
    )
    expect(background.times()).toEqual([0, 500])
  })
})

describe('the order of answers at the hook (F9)', () => {
  it('does not let an older failed read override a newer complete answer', async () => {
    const background = heldReads()
    const { result } = renderCard(background.getAddressBalanceV2)
    let older!: Promise<unknown>
    let newer!: Promise<unknown>
    act(() => {
      older = result.current.startRead().catch(() => undefined)
      newer = result.current.startRead()
    })
    await act(async () => {
      background.reads[1]!.resolve(complete)
      await newer
    })
    await act(async () => {
      background.reads[0]!.reject(new Error('explorer timed out'))
      await older
    })
    expect(result.current.card.status).toMatchObject({ kind: 'ready', busy: false })
  })
})

describe('the clock (item 10)', () => {
  it('waits again for the time still to come when its timer fires early, as after the clock stepped back', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const { result } = renderCard(background.getAddressBalanceV2)
    await advance(10_000)
    await act(async () => {
      background.reads[0]!.reject(new Error('explorer unreachable'))
    })
    // The quick read from 11.5 s never answers. At 25 s the clock steps back 5 s.
    await advance(15_000)
    vi.setSystemTime(Date.now() - 5_000)
    // The timer set for 40 s fires when the clock reads 35 s: too early.
    await advance(15_000)
    expect(result.current.card.status.kind).toBe('loading')
    // 30 s of the clock after the failed read began: it shows.
    await advance(5_000)
    expect(result.current.card.status.kind).toBe('failed-empty')
  })
})

describe('a network switch (item 4)', () => {
  it('reads nothing of the previous network’s account, and the new one once', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const harness = harnessFor(background.getAddressBalanceV2)
    renderHook(
      () => {
        AccountUpdater()
        return useBalanceCardLogic()
      },
      { wrapper: harness.wrapper }
    )
    await act(async () => {
      background.reads[0]!.resolve(complete)
    })
    await advance(3_000)
    // The network changes first; the account a moment later.
    act(() => {
      harness.store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })
    await advance(200)
    expect(background.reads.map(read => read.address)).toEqual([address])
    act(() => {
      harness.store.dispatch(
        accountActions.setCurrent({ address: 'tq1-testnet-account', key: 'account-1' } as never)
      )
    })
    expect(background.reads.map(read => read.address)).toEqual([address, 'tq1-testnet-account'])
  })

  function switchNetworkOnly() {
    vi.useFakeTimers()
    const background = heldReads()
    const harness = harnessFor(background.getAddressBalanceV2)
    const view = renderHook(
      () => {
        AccountUpdater()
        return { card: useBalanceCardLogic(), fetchBalance: useFetchBalanceCallback() }
      },
      { wrapper: harness.wrapper }
    )
    return { background, harness, view }
  }

  it('reads nothing of the account on the new network while it is still the previous one’s, for 5 s at most, then reads the account selected, as when the reload fails (item 11, B; round 4 item 4)', async () => {
    const { background, harness, view } = switchNetworkOnly()
    await act(async () => {
      background.reads[0]!.resolve(complete)
    })
    act(() => {
      harness.store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })
    // The reload of accounts never ends.
    await advance(4_999)
    expect(background.reads).toHaveLength(1)
    expect(view.result.current.card.status.kind).toBe('loading')
    expect(view.result.current.card.canRefresh).toBe(false)
    await advance(1)
    expect(view.result.current.card.canRefresh).toBe(true)
    expect(background.reads.map(read => read.at)).toEqual([0, 5_000])
  })

  it('reads the account selected once the page’s load of its accounts for the new network ends, though it failed (B)', async () => {
    const { background, harness } = switchNetworkOnly()
    await act(async () => {
      background.reads[0]!.resolve(complete)
    })
    act(() => {
      harness.store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })
    await advance(1_000)
    // A load for the previous network ending changes nothing.
    act(() => {
      harness.store.dispatch(accountsReloaded({ chainType: ChainType.QBIT_MAINNET }))
    })
    expect(background.reads).toHaveLength(1)
    act(() => {
      harness.store.dispatch(accountsReloaded({ chainType: ChainType.QBIT_TESTNET4 }))
    })
    expect(background.reads.map(read => read.address)).toEqual([address, address])
  })

  it('does not wait for an account whose own address on the new network is the one selected (B)', async () => {
    const { background, harness } = switchNetworkOnly()
    act(() => {
      harness.store.dispatch(
        accountActions.setCurrent({
          address,
          key: 'account-1',
          pubkey: '11'.repeat(32),
          type: 'Qbit HD Key Tree',
          p2mr: {
            addresses: { mainnet: address, testnet4: address, signet: address, regtest: 'other' },
          },
        } as never)
      )
    })
    await act(async () => {
      background.reads[0]!.resolve(complete)
    })
    act(() => {
      harness.store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })
    expect(background.reads).toHaveLength(2)
  })

  it('records the end of a load of the accounts, failed or not, for the network it was for (B)', async () => {
    const wallet = {
      ...createWalletMock(),
      getKeyrings: vi.fn(async () => {
        throw new Error('background busy')
      }),
    }
    const harness = createHookTestHarness({ wallet: wallet as never })
    const { result } = renderHook(() => useReloadAccounts(), { wrapper: harness.wrapper })
    await act(async () => {
      await expect(result.current()).rejects.toThrow('background busy')
    })
    expect(harness.store.getState().accounts.accountsLoaded).toMatchObject({
      chainType: harness.store.getState().settings.chainType,
      count: 1,
    })
  })
})

describe('the count beside the refresh control (A)', () => {
  it.each(['en', 'fr', 'es', 'ru'])(
    'is short, grouped as balances are, in %s; the full sentence stays for the control',
    async locale => {
      vi.useFakeTimers()
      const background = heldReads()
      const harness = harnessFor(background.getAddressBalanceV2)
      const t = (key: string, args?: unknown) =>
        Array.isArray(args) ? `${key}:${args.join('|')}` : key
      const wrapper = ({ children }: { children?: React.ReactNode }) =>
        createElement(
          harness.wrapper,
          null,
          createElement(
            I18nContext.Provider,
            { value: { ...defaultI18n, t, locale } as never },
            children
          )
        )
      const { result } = renderHook(
        () => ({ card: useBalanceCardLogic(), fetchBalance: useFetchBalanceCallback() }),
        { wrapper }
      )
      act(() => {
        result.current.fetchBalance().catch(() => undefined)
      })
      const { progressId } = background.reads[0]!
      act(() => {
        for (const event of [
          { kind: 'total', totalBalance: 91_000_000 },
          { kind: 'outputs', read: 2_888, total: 3_346 },
        ]) {
          uiEventBus.emit(QBIT_BALANCE_READ_PROGRESS, {
            progressId,
            address,
            chainType: ChainType.QBIT_MAINNET,
            ...event,
          })
        }
      })
      await advance(3_000)
      expect(result.current.card.statusShortText).toBe('2,888 / 3,346')
      expect(result.current.card.statusText).toBe('balance_reading_outputs:2,888|3,346')
    }
  )
})

describe('a guard-busy answer over a shown split (item 3)', () => {
  it('keeps the split shown, dimmed, and reads again at the usual pace, not quickly', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const { result } = renderCard(background.getAddressBalanceV2)
    await advance(10_000)
    await act(async () => {
      background.reads[0]!.resolve(complete)
    })
    await advance(10_000)
    // A send holds the guard: the total, no split.
    await act(async () => {
      background.reads[1]!.resolve({
        ...complete,
        availableBalance: null,
        unavailableBalance: 91_000_000,
      })
    })
    expect(result.current.card.status).toMatchObject({
      kind: 'refreshing',
      reason: 'retry',
      shown: { source: 'last', split: { kind: 'known', available: 60_000_000 } },
    })
    // 10 s after the last read began, not 1.5 s after it ended.
    await advance(9_999)
    expect(background.times()).toEqual(seconds(10, 20))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 20, 30))
  })
})

describe('what a screen reader is told (item 12)', () => {
  it('says that a long read is updating while each of its reads is under way, and nothing between them (round 4 item 6)', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const { result } = renderCard(background.getAddressBalanceV2)
    const report = (index: number, read: number) => {
      const { progressId } = background.reads[index]!
      uiEventBus.emit(QBIT_BALANCE_READ_PROGRESS, {
        progressId,
        kind: 'total',
        address,
        chainType: ChainType.QBIT_MAINNET,
        totalBalance: 92_000_000,
      })
      uiEventBus.emit(QBIT_BALANCE_READ_PROGRESS, {
        progressId,
        kind: 'outputs',
        address,
        chainType: ChainType.QBIT_MAINNET,
        read,
        total: 3_000,
      })
    }
    await advance(10_000)
    act(() => report(0, 1_000))
    await advance(3_000)
    expect(result.current.card.status).toMatchObject({ kind: 'total', progress: { read: 1_000 } })
    expect(result.current.card.liveText).toBe('balance_updating')
    // The read ends without every output; the card reads on 1.5 s later:
    // nothing is said while nothing reads, and again once that read has a
    // count to show.
    await act(async () => {
      background.reads[0]!.resolve(incomplete)
    })
    expect(result.current.card.status.kind).toBe('total')
    expect(result.current.card.liveText).toBeUndefined()
    await advance(1_500)
    act(() => report(1, 2_000))
    await advance(3_000)
    expect(result.current.card.liveText).toBe('balance_updating')
  })

  it('says the card is updating as a read it asked for begins, not for a background poll, and nothing between reads (round 4 item 6)', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const { result } = renderCard(background.getAddressBalanceV2)
    await advance(10_000)
    await act(async () => {
      background.reads[0]!.resolve(complete)
    })
    expect(result.current.card.liveText).toBeUndefined()
    // A background poll past its quiet second: dimmed, and nothing said.
    await advance(10_000)
    await advance(1_000)
    expect(result.current.card.status).toMatchObject({ kind: 'refreshing', reason: 'poll' })
    expect(result.current.card.liveText).toBeUndefined()
    await act(async () => {
      background.reads[1]!.resolve(complete)
    })
    await advance(1_000)
    expect(result.current.card.status.kind).toBe('ready')

    // The user's refresh, once it has run its quiet start: said once.
    act(() => result.current.card.refreshBalance())
    await advance(1_400)
    expect(result.current.card.status).toMatchObject({ kind: 'refreshing', reason: 'user' })
    expect(result.current.card.liveText).toBe('balance_updating')
    // It fails: the value stays dimmed, and nothing is said until the next
    // read, 2 s later, is under way (due within a second).
    await act(async () => {
      background.reads[2]!.reject(new Error('explorer down'))
    })
    expect(result.current.card.status).toMatchObject({ kind: 'refreshing', reason: 'retry' })
    expect(result.current.card.liveText).toBeUndefined()
    await advance(1_000)
    expect(result.current.card.liveText).toBe('balance_updating')
    await advance(1_000)
    expect(background.reads).toHaveLength(4)
    expect(result.current.card.liveText).toBe('balance_updating')
    await act(async () => {
      background.reads[3]!.resolve(complete)
    })
    await advance(1_000)
    expect(result.current.card.status.kind).toBe('ready')
    expect(result.current.card.liveText).toBeUndefined()
  })
})

describe('round 3', () => {
  const testnetAddress = 'tq1-the-account-on-testnet'

  it('waits on a card shown afresh after Settings, Switch network, while the account is still the previous network’s: no read, no kept answer, no reader (item 2)', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const kept: string[] = []
    const harness = harnessFor(background.getAddressBalanceV2, {
      getKeptAddressBalance: async (asked: string) => {
        kept.push(asked)
        return null
      },
    })
    // The page loaded its accounts for the mainnet earlier.
    act(() => {
      harness.store.dispatch(accountsReloaded({ chainType: ChainType.QBIT_MAINNET }))
    })
    // NetworkTypeScreen: the network changes, the reload of accounts is
    // under way, and Home shows at once, its card mounting afresh.
    act(() => {
      harness.store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })
    const view = renderHook(
      () => ({ card: useBalanceCardLogic(), fetchBalance: useFetchBalanceCallback() }),
      { wrapper: harness.wrapper }
    )
    await advance(4_000)
    expect(background.reads).toHaveLength(0)
    expect(kept).toEqual([])
    expect(balanceCardFor(harness.store, address)).toBeUndefined()
    expect(view.result.current.card.canRefresh).toBe(false)
    // The reload ends: the account is the new network's, read once.
    act(() => {
      harness.store.dispatch(
        accountActions.setCurrent({ address: testnetAddress, key: 'account-1' } as never)
      )
      harness.store.dispatch(accountsReloaded({ chainType: ChainType.QBIT_TESTNET4 }))
    })
    await advance(10_000)
    expect(background.reads.map(read => read.address)).toEqual([testnetAddress])
    expect(kept).toEqual([testnetAddress])
    expect(view.result.current.card.canRefresh).toBe(true)
  })

  it('refuses a refresh from elsewhere during the wait, and a press of the refresh control reads nothing (item 7)', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const harness = harnessFor(background.getAddressBalanceV2)
    act(() => {
      harness.store.dispatch(accountsReloaded({ chainType: ChainType.QBIT_MAINNET }))
      harness.store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })
    const view = renderHook(
      () => ({ card: useBalanceCardLogic(), fetchBalance: useFetchBalanceCallback() }),
      { wrapper: harness.wrapper }
    )
    let answer: unknown = 'pending'
    await act(async () => {
      answer = await view.result.current.fetchBalance()
    })
    expect(answer).toBeUndefined()
    act(() => view.result.current.card.refreshBalance())
    await advance(2_000)
    expect(background.reads).toHaveLength(0)
  })

  it('begins a refresh queued behind a read lost for good once that read is 60 s old, with no card to give up on it (item 6)', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const harness = harnessFor(background.getAddressBalanceV2)
    // The Send screen: no card, a read in flight that never answers.
    const view = renderHook(
      () => ({ start: useStartBalanceReadCallback(), fetchBalance: useFetchBalanceCallback() }),
      { wrapper: harness.wrapper }
    )
    act(() => {
      view.result.current.start().catch(() => undefined)
    })
    await advance(5_000)
    let refreshed!: Promise<unknown>
    act(() => {
      refreshed = view.result.current.fetchBalance()
    })
    // Past the give-up, by the margin left for a card to give up first.
    await advance(55_999)
    expect(background.times()).toEqual([0])
    await advance(1)
    expect(background.times()).toEqual(seconds(0, 61))
    await act(async () => {
      background.reads[1]!.resolve(complete)
    })
    await expect(refreshed).resolves.toEqual(complete)
  })

  it('neither adopts nor joins a read in flight of the address on another network (item 8)', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const harness = harnessFor(background.getAddressBalanceV2)
    // An address the same on both networks.
    act(() => {
      harness.store.dispatch(
        accountActions.setCurrent({
          address,
          key: 'account-1',
          pubkey: '11'.repeat(32),
          type: 'Qbit HD Key Tree',
          p2mr: {
            addresses: { mainnet: address, testnet4: address, signet: address, regtest: 'r' },
          },
        } as never)
      )
    })
    const reader = renderHook(() => useStartBalanceReadCallback(), { wrapper: harness.wrapper })
    // A read on the mainnet, never answering, then the network changes.
    act(() => {
      reader.result.current().catch(() => undefined)
    })
    act(() => {
      harness.store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })
    const view = renderHook(() => useBalanceCardLogic(), { wrapper: harness.wrapper })
    // A press reads on the new network rather than join the mainnet read.
    act(() => view.result.current.refreshBalance())
    await advance(1_000)
    expect(background.reads).toHaveLength(2)
    await act(async () => {
      background.reads[1]!.resolve({ ...complete, chainType: ChainType.QBIT_TESTNET4 })
    })
    // The card's poll does not hold the mainnet read: it reads 10 s after
    // its own read, rather than wait for that one.
    await advance(10_000)
    expect(background.reads).toHaveLength(3)
    // Nor does it give up on it as its own at 60 s (its read of 11 s is not
    // yet 60 s old then).
    await advance(53_000)
    expect(harness.store.getState().accounts.balanceReadMap[address]?.failed).toBeUndefined()
    expect(view.result.current.status.kind).not.toMatch(/failed/)
  })
})

describe('round 4', () => {
  /** The page hidden or shown again, as the browser tells it. */
  async function showPage(shown: boolean): Promise<void> {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => !shown })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
  }

  /** A screen without the card: reads begun at once, and a refresh from elsewhere. */
  function renderReader(harness: ReturnType<typeof harnessFor>) {
    return renderHook(
      () => ({ start: useStartBalanceReadCallback(), fetchBalance: useFetchBalanceCallback() }),
      { wrapper: harness.wrapper }
    )
  }

  it('gives up on the read it holds before a refresh queued behind it begins: the give-up counts as a failed read, its progress is no longer recorded, and the refresh begins once (item 1)', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const { store, result } = renderCard(background.getAddressBalanceV2)
    // The card's poll reads at 10 s; that read never answers.
    await advance(10_000)
    const lost = background.reads[0]!
    const lostId = store.getState().accounts.balanceReadMap[address]!.reading!.requestId
    // A refresh from elsewhere waits for it.
    let refreshed!: Promise<unknown>
    act(() => {
      refreshed = result.current.fetchBalance()
    })
    // Whether the give-up was counted by the time the refresh's read began.
    let countedFirst: boolean | undefined
    const unsubscribe = store.subscribe(() => {
      const record = store.getState().accounts.balanceReadMap[address]
      if (countedFirst === undefined && (record?.reading?.requestId ?? 0) > lostId) {
        countedFirst = record?.failed?.reads.some(read => read.requestId === lostId) === true
      }
    })
    await advance(59_999)
    expect(background.times()).toEqual(seconds(10))
    await advance(1)
    unsubscribe()
    expect(background.times()).toEqual(seconds(10, 70))
    expect(countedFirst).toBe(true)
    expect(
      store.getState().accounts.balanceReadMap[address]?.failed?.reads.map(read => read.requestId)
    ).toEqual([lostId])
    // A report of the read given up on changes nothing.
    let changes = 0
    const count = store.subscribe(() => {
      changes += 1
    })
    act(() => {
      uiEventBus.emit(QBIT_BALANCE_READ_PROGRESS, {
        progressId: lost.progressId,
        kind: 'total',
        address,
        chainType: ChainType.QBIT_MAINNET,
        totalBalance: 92_000_000,
      })
    })
    count()
    expect(changes).toBe(0)
    // Nothing else begins before the refresh's read answers, its own
    // deadline past the card's give-up included.
    await advance(5_000)
    expect(background.times()).toEqual(seconds(10, 70))
    await act(async () => {
      background.reads[1]!.resolve(complete)
    })
    await expect(refreshed).resolves.toEqual(complete)
    expect(result.current.card.status.kind).toBe('ready')
  })

  it('counts the read it gives up on as failed once the page is shown again, though a refresh queued behind it began meanwhile, the card hidden (item 1)', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const { store, result } = renderCard(background.getAddressBalanceV2)
    await advance(10_000)
    const lostId = store.getState().accounts.balanceReadMap[address]!.reading!.requestId
    act(() => {
      result.current.fetchBalance().catch(() => undefined)
    })
    // Hidden from 30 s, the card's poll paused: the refresh begins at 71 s,
    // once the read it waits for is past the give-up.
    await advance(20_000)
    await showPage(false)
    await advance(41_000)
    expect(background.times()).toEqual(seconds(10, 71))
    await advance(8_000)
    expect(store.getState().accounts.balanceReadMap[address]?.failed).toBeUndefined()
    // Shown again at 80 s: the card gives up on its read of 10 s, counted.
    await showPage(true)
    await advance(0)
    expect(
      store.getState().accounts.balanceReadMap[address]?.failed?.reads.map(read => read.requestId)
    ).toEqual([lostId])
  })

  it('drops a read lost with no card to give up on it and asks again, refused while the card waits for the new network’s account: nothing reads the previous network’s address there (item 2)', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const harness = harnessFor(background.getAddressBalanceV2)
    act(() => {
      harness.store.dispatch(accountsReloaded({ chainType: ChainType.QBIT_MAINNET }))
    })
    // A read that never answers, and a refresh behind it.
    const reader = renderReader(harness)
    act(() => {
      reader.result.current.start().catch(() => undefined)
    })
    let refreshed!: Promise<unknown>
    act(() => {
      refreshed = reader.result.current.fetchBalance()
    })
    // At 59 s the network changes, and Home shows its card afresh, waiting.
    await advance(59_000)
    act(() => {
      harness.store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })
    const card = renderHook(() => useBalanceCardLogic(), { wrapper: harness.wrapper })
    expect(card.result.current.canRefresh).toBe(false)
    // At 61 s the lost read is dropped, and the refresh, asked again, refused.
    await advance(2_000)
    expect(background.reads).toHaveLength(1)
    expect(balanceReadInFlight(harness.store, address)).toBeUndefined()
    await expect(refreshed).resolves.toBeUndefined()
  })

  it('asks again for a refresh whose read was lost, queued behind a newer read in flight rather than beside it (item 2)', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const harness = harnessFor(background.getAddressBalanceV2)
    const reader = renderReader(harness)
    // A read that never answers, and a refresh behind it.
    act(() => {
      reader.result.current.start().catch(() => undefined)
    })
    let refreshed!: Promise<unknown>
    act(() => {
      refreshed = reader.result.current.fetchBalance()
    })
    // A newer read at 30 s takes its place in flight.
    await advance(30_000)
    act(() => {
      reader.result.current.start().catch(() => undefined)
    })
    // The lost read's deadline at 61 s: the refresh waits for the newer one.
    await advance(35_000)
    expect(background.times()).toEqual(seconds(0, 30))
    await act(async () => {
      background.reads[1]!.resolve(complete)
    })
    await advance(0)
    expect(background.times()).toEqual(seconds(0, 30, 65))
    await act(async () => {
      background.reads[2]!.resolve(complete)
    })
    await expect(refreshed).resolves.toEqual(complete)
  })

  it('does not take a load of the accounts for the previous network, ending after the new network’s, for the new network’s (item 4)', async () => {
    const failLoad: Array<(error: Error) => void> = []
    const wallet = {
      ...createWalletMock(),
      getKeyrings: vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            failLoad.push(reject)
          })
      ),
    }
    const harness = createHookTestHarness({ wallet: wallet as never })
    act(() => {
      harness.store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_MAINNET }))
    })
    const { result } = renderHook(() => useReloadAccounts(), { wrapper: harness.wrapper })
    let previous!: Promise<unknown>
    act(() => {
      previous = result.current().catch(() => undefined)
    })
    act(() => {
      harness.store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })
    let current!: Promise<unknown>
    act(() => {
      current = result.current().catch(() => undefined)
    })
    await act(async () => {
      failLoad[1]!(new Error('background busy'))
      await current
    })
    await act(async () => {
      failLoad[0]!(new Error('background busy'))
      await previous
    })
    expect(harness.store.getState().accounts.accountsLoaded).toMatchObject({
      chainType: ChainType.QBIT_TESTNET4,
    })
  })

  it('waits on a card shown afresh after a switch made before any load of the accounts ended: the accounts the page opened with are its first network’s (item 4)', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const harness = harnessFor(background.getAddressBalanceV2)
    // The page opens on a screen without the card; its load of the accounts
    // never ends.
    renderHook(() => AccountUpdater(), { wrapper: harness.wrapper })
    await act(async () => {
      background.reads[0]!.resolve(complete)
    })
    act(() => {
      harness.store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })
    const card = renderHook(() => useBalanceCardLogic(), { wrapper: harness.wrapper })
    await advance(4_000)
    expect(card.result.current.canRefresh).toBe(false)
    expect(balanceCardFor(harness.store, address)).toBeUndefined()
    expect(background.reads).toHaveLength(1)
  })

  it('has the account updater read nothing while the card waits for the new network’s account, an unlock included (item 5)', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const harness = harnessFor(background.getAddressBalanceV2)
    const view = renderHook(
      () => {
        AccountUpdater()
        return useBalanceCardLogic()
      },
      { wrapper: harness.wrapper }
    )
    await act(async () => {
      background.reads[0]!.resolve(complete)
    })
    act(() => {
      harness.store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })
    // The wallet locks and is unlocked again during the wait.
    await advance(1_000)
    act(() => {
      harness.store.dispatch(globalActions.update({ isUnlocked: false }))
    })
    act(() => {
      harness.store.dispatch(globalActions.update({ isUnlocked: true }))
    })
    await advance(3_999)
    expect(background.reads).toHaveLength(1)
    expect(view.result.current.canRefresh).toBe(false)
  })

  it('reads as the page is shown again with a failure counted, but not within 2 s of the previous read’s start (item 7)', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    renderCard(background.getAddressBalanceV2)
    await advance(10_000)
    await act(async () => {
      background.reads[0]!.resolve(complete)
    })
    // Two failed reads, at 20 s and the read after a first failure at 22 s.
    await advance(10_000)
    await act(async () => {
      background.reads[1]!.reject(new Error('explorer unreachable'))
    })
    await advance(2_000)
    await act(async () => {
      background.reads[2]!.reject(new Error('explorer unreachable'))
    })
    expect(background.times()).toEqual(seconds(10, 20, 22))
    // Hidden at 22.5 s, shown again at 23 s: read at 24 s, 2 s after the
    // previous read began, not at once nor after the back-off.
    await advance(500)
    await showPage(false)
    await advance(500)
    await showPage(true)
    await advance(999)
    expect(background.times()).toEqual(seconds(10, 20, 22))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 20, 22, 24))
  })
})

describe('round 5', () => {
  it('ends the wait for the new network’s account though its timer fires a moment early (item 1)', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const harness = harnessFor(background.getAddressBalanceV2)
    const view = renderHook(
      () => {
        AccountUpdater()
        return useBalanceCardLogic()
      },
      { wrapper: harness.wrapper }
    )
    await act(async () => {
      background.reads[0]!.resolve(complete)
    })
    act(() => {
      harness.store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })
    // The clock steps back 1 ms: the wait's timer fires 1 ms before the
    // wait ends by the clock, and the card arms it again.
    vi.setSystemTime(Date.now() - 1)
    await advance(5_000)
    expect(view.result.current.canRefresh).toBe(false)
    await advance(1)
    expect(view.result.current.canRefresh).toBe(true)
    expect(background.reads).toHaveLength(2)
  })

  it('stops recording the progress of a lost read whose place in flight a newer read took (item 2)', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const harness = harnessFor(background.getAddressBalanceV2)
    const reader = renderHook(
      () => ({ start: useStartBalanceReadCallback(), fetchBalance: useFetchBalanceCallback() }),
      { wrapper: harness.wrapper }
    )
    // A read that never answers, a refresh behind it, and a newer read at
    // 30 s in its place in flight.
    act(() => {
      reader.result.current.start().catch(() => undefined)
    })
    act(() => {
      reader.result.current.fetchBalance().catch(() => undefined)
    })
    await advance(30_000)
    act(() => {
      reader.result.current.start().catch(() => undefined)
    })
    // At 61 s the first read is lost: a report of it changes nothing.
    await advance(31_000)
    let changes = 0
    const unsubscribe = harness.store.subscribe(() => {
      changes += 1
    })
    act(() => {
      uiEventBus.emit(QBIT_BALANCE_READ_PROGRESS, {
        progressId: background.reads[0]!.progressId,
        kind: 'total',
        address,
        chainType: ChainType.QBIT_MAINNET,
        totalBalance: 92_000_000,
      })
    })
    unsubscribe()
    expect(changes).toBe(0)
  })
})

describe('round 6: the switcher’s row of the selected account shows the card’s total (item 1)', () => {
  /** The card and the switcher's row of the selected account, on one page. */
  function renderCardAndRow(
    getAddressBalanceV2: (...args: any[]) => Promise<unknown>,
    more: Record<string, unknown> = {}
  ) {
    const harness = harnessFor(getAddressBalanceV2, more)
    const view = renderHook(
      () => ({ card: useBalanceCardLogic(), row: useCurrentAccountBalanceTotal() }),
      { wrapper: harness.wrapper }
    )
    return { ...harness, ...view }
  }

  const cardTotal = (card: ReturnType<typeof useBalanceCardLogic>): number | undefined =>
    card.status.kind === 'loading' || card.status.kind === 'failed-empty'
      ? undefined
      : card.status.shown.total

  /** The background reports `total` for the read `read`, before its answer. */
  const reportTotal = (read: Read, total: number): void =>
    act(() => {
      uiEventBus.emit(QBIT_BALANCE_READ_PROGRESS, {
        progressId: read.progressId,
        kind: 'total',
        address,
        chainType: ChainType.QBIT_MAINNET,
        totalBalance: total,
      })
    })

  it('shows the total of an answer that could not read every output, over a complete one of another total, as the card does', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const { result } = renderCardAndRow(background.getAddressBalanceV2)
    await advance(10_000)
    await act(async () => {
      background.reads[0]!.resolve(complete)
    })
    expect(result.current.row).toEqual({ address, totalBalance: 91_000_000, stale: false })
    await advance(10_000)
    await act(async () => {
      background.reads[1]!.resolve(incomplete)
    })
    expect(cardTotal(result.current.card)).toBe(92_000_000)
    // The answer is the newest read's own total: not out of date.
    expect(result.current.row).toEqual({ address, totalBalance: 92_000_000, stale: false })
  })

  it('shows the early total of a read in flight, as the card does', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const { result } = renderCardAndRow(background.getAddressBalanceV2)
    await advance(10_000)
    await act(async () => {
      background.reads[0]!.resolve(complete)
    })
    await advance(10_000)
    await act(async () => {
      background.reads[1]!.resolve(incomplete)
    })
    while (background.reads.length < 3) await advance(500)
    reportTotal(background.reads[2]!, 93_000_000)
    expect(cardTotal(result.current.card)).toBe(93_000_000)
    expect(result.current.row).toEqual({ address, totalBalance: 93_000_000, stale: false })
  })

  it('shows, under a failure shown, the total the card shows, not the early total of the read in flight nor the complete answer stored', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const { result } = renderCardAndRow(background.getAddressBalanceV2)
    await advance(10_000)
    await act(async () => {
      background.reads[0]!.resolve(complete)
    })
    // Three reads in turn tell a total of 95,000,000 and then fail: the
    // failure shown from the third on.
    for (const index of [1, 2, 3]) {
      while (background.reads.length <= index) await advance(500)
      reportTotal(background.reads[index]!, 95_000_000)
      await act(async () => {
        background.reads[index]!.reject(new Error('explorer unreachable'))
      })
    }
    expect(result.current.card.status).toMatchObject({ kind: 'failed', totalCurrent: true })
    expect(cardTotal(result.current.card)).toBe(95_000_000)
    // The next read tells another total while in flight.
    while (background.reads.length <= 4) await advance(500)
    reportTotal(background.reads[4]!, 99_000_000)
    expect(result.current.card.status.kind).toBe('failed')
    expect(cardTotal(result.current.card)).toBe(95_000_000)
    // The newest settled read told it, though that read then failed.
    expect(result.current.row).toEqual({ address, totalBalance: 95_000_000, stale: false })
  })

  it('marks the row out of date as before when the latest refresh failed and told no newer total', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const { result } = renderCardAndRow(background.getAddressBalanceV2)
    await advance(10_000)
    await act(async () => {
      background.reads[0]!.resolve(complete)
    })
    await advance(10_000)
    await act(async () => {
      background.reads[1]!.reject(new Error('explorer unreachable'))
    })
    expect(cardTotal(result.current.card)).toBe(91_000_000)
    expect(result.current.row).toEqual({ address, totalBalance: 91_000_000, stale: true })
  })

  it('shows the background’s kept answer the card shows before the page has read the account', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const kept = {
      ...complete,
      availableBalance: 49_000_000,
      totalBalance: 80_000_000,
    }
    const { result } = renderCardAndRow(background.getAddressBalanceV2, {
      getKeptAddressBalance: async () => ({ balance: kept, readAt: Date.now() - 60_000 }),
    })
    await advance(0)
    expect(background.reads).toHaveLength(0)
    expect(result.current.card.status).toMatchObject({ shown: { source: 'kept' } })
    expect(result.current.row).toEqual({ address, totalBalance: 80_000_000, stale: false })
  })

  it('withdraws what the card published as it unmounts: the row then shows the account’s balance read', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const { result, store, unmount } = renderCardAndRow(background.getAddressBalanceV2)
    await advance(10_000)
    await act(async () => {
      background.reads[0]!.resolve(complete)
    })
    await advance(10_000)
    await act(async () => {
      background.reads[1]!.resolve(incomplete)
    })
    expect(store.getState().accounts.balanceCardTotal).toMatchObject({
      address,
      totalBalance: 92_000_000,
    })
    const row = renderHook(() => useCurrentAccountBalanceTotal(), {
      wrapper: createHookTestHarness({ store }).wrapper,
    })
    expect(row.result.current?.totalBalance).toBe(92_000_000)
    unmount()
    expect(store.getState().accounts.balanceCardTotal).toBeUndefined()
    expect(row.result.current?.totalBalance).toBe(91_000_000)
    void result
  })

  it.each([
    [
      'another account is selected',
      () => accountActions.setCurrent({ address: 'qbit-second-account', key: 'account-2' } as any),
    ],
    [
      'another network is shown',
      () => settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }),
    ],
  ])('withdraws what the card published when %s and it shows no total', async (_case, change) => {
    vi.useFakeTimers()
    const background = heldReads()
    const { result, store } = renderCardAndRow(background.getAddressBalanceV2)
    await advance(10_000)
    await act(async () => {
      background.reads[0]!.resolve(complete)
    })
    expect(store.getState().accounts.balanceCardTotal).toMatchObject({ totalBalance: 91_000_000 })
    act(() => {
      store.dispatch(change())
    })
    expect(result.current.card.status.kind).toBe('loading')
    expect(store.getState().accounts.balanceCardTotal).toBeUndefined()
    expect(result.current.row).toBeNull()
  })

  it('publishes only when what the card shows changes, not on every render', async () => {
    vi.useFakeTimers()
    const background = heldReads()
    const { store } = renderCardAndRow(background.getAddressBalanceV2)
    const published: unknown[] = []
    const unsubscribe = store.subscribe(() => {
      const total = store.getState().accounts.balanceCardTotal
      if (total !== published[published.length - 1]) published.push(total)
    })
    // Four polls, each answering the same complete balance.
    for (let index = 0; index < 4; index += 1) {
      while (background.reads.length <= index) await advance(500)
      await advance(1_500)
      await act(async () => {
        background.reads[index]!.resolve(complete)
      })
    }
    unsubscribe()
    expect(background.reads).toHaveLength(4)
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ totalBalance: 91_000_000 })
  })
})

describe('round 6: a page shown again while a read is in flight (item 2)', () => {
  async function showPage(shown: boolean): Promise<void> {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => !shown })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
  }

  /** A complete answer at 10 s, a failed poll at 20 s, and the read after it, at 22 s, in flight. */
  async function failureCountedReadInFlight() {
    vi.useFakeTimers()
    const background = heldReads()
    const view = renderCard(background.getAddressBalanceV2)
    await advance(10_000)
    await act(async () => {
      background.reads[0]!.resolve(complete)
    })
    await advance(10_000)
    await act(async () => {
      background.reads[1]!.reject(new Error('explorer unreachable'))
    })
    await advance(2_000)
    expect(background.times()).toEqual(seconds(10, 20, 22))
    return { background, view }
  }

  it('reads as soon as the read in flight when the page was shown again fails, not after the back-off', async () => {
    const { background, view } = await failureCountedReadInFlight()
    // Hidden at 25 s, shown again at 26 s, the read of 22 s still in flight.
    await advance(3_000)
    await showPage(false)
    await advance(1_000)
    await showPage(true)
    expect(background.times()).toEqual(seconds(10, 20, 22))
    await advance(2_000)
    await act(async () => {
      background.reads[2]!.reject(new Error('explorer unreachable'))
    })
    expect(background.times()).toEqual(seconds(10, 20, 22, 28))
    expect(view.result.current.card.status.busy).toBe(true)
  })

  it('reads at the usual pace when that read answers', async () => {
    const { background } = await failureCountedReadInFlight()
    await advance(3_000)
    await showPage(false)
    await advance(1_000)
    await showPage(true)
    await advance(2_000)
    await act(async () => {
      background.reads[2]!.resolve(complete)
    })
    await advance(3_999)
    expect(background.times()).toEqual(seconds(10, 20, 22))
    await advance(1)
    expect(background.times()).toEqual(seconds(10, 20, 22, 32))
  })

  it('reads nothing more when the page is hidden again before that read fails', async () => {
    const { background } = await failureCountedReadInFlight()
    await advance(3_000)
    await showPage(false)
    await advance(1_000)
    await showPage(true)
    await advance(1_000)
    await showPage(false)
    await advance(1_000)
    await act(async () => {
      background.reads[2]!.reject(new Error('explorer unreachable'))
    })
    await advance(10_000)
    expect(background.times()).toEqual(seconds(10, 20, 22))
  })

  it('sends no burst while the page is hidden and shown again ten times during an outage: one read per 2 s at most', async () => {
    vi.useFakeTimers()
    const startedAt = Date.now()
    const times: number[] = []
    // A complete answer, then every read fails half a second after it begins.
    const getAddressBalanceV2 = (): Promise<unknown> => {
      times.push(Date.now() - startedAt)
      if (times.length === 1) return Promise.resolve(complete)
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('explorer unreachable')), 500)
      })
    }
    renderCard(getAddressBalanceV2)
    await advance(22_600)
    expect(times).toEqual(seconds(10, 20, 22.5))
    for (let cycle = 0; cycle < 10; cycle += 1) {
      await showPage(false)
      await advance(100)
      await showPage(true)
      await advance(200)
    }
    await advance(1_000)
    const outage = times.slice(1)
    const gaps = outage.slice(1).map((at, index) => at - outage[index]!)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2_000)
    // From the first failed read at 20 s to the end, 6.6 s: four reads at most.
    expect(outage.length).toBeLessThanOrEqual(4)
    expect(outage.length).toBeGreaterThan(2)
  })
})
