import { act, render } from '@testing-library/react'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUS_METHODS, QBIT_BALANCE_READ_PROGRESS } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import { useFetchBalanceCallback } from '../../src/hooks/accounts'
import { accountActions } from '../../src/reducers/accounts'
import { globalActions } from '../../src/reducers/global'
import { useBalanceCardLogic } from '../../src/ui-hooks/useBalanceCardLogic'
import { AccountUpdater } from '../../src/updater/accounts'
import { uiEventBus } from '../../src/utils/eventBus'
import { createHookTestHarness, createWalletMock } from './testHelpers'

// The card's status over time on a page that opens with the account updater
// and the card, the background scripted read by read: the explorer hiccups
// and outages the card must show as loading, refreshing or, only when they
// last, a failure. Time is in ms since the page opened.

const ADDRESS = 'qbit-timeline-account'
const OPEN = Date.UTC(2026, 10, 18, 12, 0, 0)

const complete = (total = 91_000_000) => ({
  availableBalance: total - 31_000_000,
  unavailableBalance: 31_000_000,
  totalBalance: total,
  immatureBalance: 0,
  pendingBalance: 31_000_000,
  chainType: ChainType.QBIT_MAINNET,
})
const incomplete = (failed = false, total = 91_000_000) => ({
  availableBalance: null,
  unavailableBalance: total,
  totalBalance: total,
  immatureBalance: null,
  pendingBalance: null,
  utxoReadIncomplete: true,
  ...(failed ? { utxoReadFailed: true } : {}),
  chainType: ChainType.QBIT_MAINNET,
})

type End =
  | { kind: 'complete'; at: number; total?: number }
  | { kind: 'incomplete'; at: number; failed?: boolean; total?: number }
  | { kind: 'reject'; at: number }
  | { kind: 'never' }

/** What a read begun at `began` does: its total (`totalBalance`) `totalAt` ms in, and how it ends. */
interface ReadPlan {
  totalAt?: number
  totalBalance?: number
  end: End
}

const healthy = (): ReadPlan => ({ totalAt: 300, end: { kind: 'complete', at: 800 } })

function scriptedBackground(plan: (began: number, index: number) => ReadPlan) {
  const began: number[] = []
  const getAddressBalanceV2 = (address: string, options?: { progressId?: string }) => {
    const at = Date.now() - OPEN
    began.push(at)
    const read = plan(at, began.length - 1)
    if (read.totalAt !== undefined && options?.progressId) {
      setTimeout(() => {
        uiEventBus.emit(QBIT_BALANCE_READ_PROGRESS, {
          progressId: options.progressId,
          kind: 'total',
          address,
          chainType: ChainType.QBIT_MAINNET,
          totalBalance: read.totalBalance ?? 91_000_000,
        })
      }, read.totalAt)
    }
    return new Promise((resolve, reject) => {
      const { end } = read
      if (end.kind === 'never') return
      setTimeout(() => {
        if (end.kind === 'complete') resolve(complete(end.total))
        else if (end.kind === 'incomplete') resolve(incomplete(end.failed, end.total))
        else reject(new Error('explorer unreachable'))
      }, end.at)
    })
  }
  return { began, getAddressBalanceV2 }
}

function openPage(
  plan: (began: number, index: number) => ReadPlan,
  options: { kept?: () => Promise<unknown>; locked?: boolean } = {}
) {
  vi.useFakeTimers()
  vi.setSystemTime(OPEN)
  const background = scriptedBackground(plan)
  const wallet: Record<string, unknown> = {
    ...createWalletMock(),
    getAddressBalanceV2: background.getAddressBalanceV2,
    getKeyrings: vi.fn(() => new Promise<never>(() => undefined)),
    hasVault: vi.fn(async () => true),
  }
  if (options.kept) wallet.getKeptAddressBalance = options.kept
  const harness = createHookTestHarness({ wallet: wallet as never })
  harness.store.dispatch(globalActions.update({ isUnlocked: options.locked !== true }))
  harness.store.dispatch(
    accountActions.setCurrent({
      address: ADDRESS,
      key: 'account-1',
      pubkey: '11'.repeat(32),
      type: 'Qbit HD Key Tree',
    } as never)
  )
  const latest: { card?: ReturnType<typeof useBalanceCardLogic> } = {}
  const Updater = (): null => {
    AccountUpdater()
    return null
  }
  const Card = (): null => {
    latest.card = useBalanceCardLogic()
    return null
  }
  // Another screen's refresh, as after a broadcast.
  const refresh: { fetch?: () => Promise<unknown> } = {}
  const Refresh = (): null => {
    refresh.fetch = useFetchBalanceCallback()
    return null
  }
  const tree = (card: boolean) =>
    createElement(
      harness.wrapper,
      null,
      createElement(Updater),
      createElement(Refresh),
      card ? createElement(Card) : null
    )
  const view = render(tree(options.locked !== true))
  return {
    ...harness,
    background,
    latest,
    showCard: (show: boolean) => act(() => view.rerender(tree(show))),
    refreshFromElsewhere: () => {
      act(() => {
        refresh.fetch!().catch(() => undefined)
      })
    },
    setPageHidden: (hidden: boolean) =>
      act(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
        document.dispatchEvent(new Event('visibilitychange'))
      }),
    unmount: () => view.unmount(),
  }
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** The card's status kind every `step` ms until `until`, as [ms, kind] at each change. */
async function statusesUntil(page: ReturnType<typeof openPage>, until: number, step = 100) {
  const changes: [number, string][] = []
  const take = (): void => {
    const kind = page.latest.card?.status.kind
    if (kind !== undefined && changes[changes.length - 1]?.[1] !== kind) {
      changes.push([Date.now() - OPEN, kind])
    }
  }
  take()
  while (Date.now() - OPEN < until) {
    await advance(step)
    take()
  }
  return changes
}

/** The changes from the first failed state on. */
const fromFailure = (changes: [number, string][]) =>
  changes.slice(changes.findIndex(([, kind]) => kind === 'failed' || kind === 'failed-empty'))

const failedAt = (changes: [number, string][]) =>
  changes.filter(([, kind]) => kind === 'failed' || kind === 'failed-empty')

afterEach(() => {
  vi.useRealTimers()
  delete (document as { hidden?: boolean }).hidden
})

describe('a hiccup shows no failure (the verifier’s scenarios)', () => {
  it.each<[string, (began: number, index: number) => ReadPlan]>([
    [
      'b: statistics failing for 3 s, each at once',
      b => (b < 3_000 ? { end: { kind: 'reject', at: 50 } } : healthy()),
    ],
    [
      'c: statistics failing for 3 s, each after 2 s',
      b => (b < 3_000 ? { end: { kind: 'reject', at: 2_000 } } : healthy()),
    ],
    [
      "c': statistics failing for 5 s, each after 2 s",
      b => (b < 5_000 ? { end: { kind: 'reject', at: 2_000 } } : healthy()),
    ],
    [
      'd: one lookup failing for 3 s',
      b =>
        b < 3_000
          ? { totalAt: 300, end: { kind: 'incomplete', failed: true, at: 800 } }
          : healthy(),
    ],
    [
      'l: the statistics answer, then the read rejects, twice',
      b => (b < 3_000 ? { totalAt: 300, end: { kind: 'reject', at: 900 } } : healthy()),
    ],
  ])('%s', async (_name, plan) => {
    const page = openPage(plan)
    const changes = await statusesUntil(page, 30_000)
    expect(failedAt(changes)).toEqual([])
    expect(changes[changes.length - 1]?.[1]).toBe('ready')
    page.unmount()
  })

  it.each<[string, number]>([
    ['i: a re-open with a kept answer, statistics failing for 5 s at once', 50],
    ["i': the same, each failure after 2 s", 2_000],
  ])('%s', async (_name, failAfter) => {
    const kept = () => Promise.resolve({ balance: complete(), readAt: OPEN - 60_000 })
    const page = openPage(
      b => (b < 5_000 ? { end: { kind: 'reject', at: failAfter } } : healthy()),
      {
        kept,
      }
    )
    const changes = await statusesUntil(page, 30_000)
    expect(failedAt(changes)).toEqual([])
    expect(changes[changes.length - 1]?.[1]).toBe('ready')
    page.unmount()
  })

  it.each([
    ['j1: an incomplete answer, then a rejected read', 2_000, 1_400],
    ['j2: a rejected read, then an older incomplete answer', 2_500, 400],
  ])('%s, the explorer healthy after', async (_name, incompleteAt, rejectAt) => {
    // The open read, and the refresh control tapped at 0.1 s: it joins the
    // open read, and the reads after it are the poll's.
    const page = openPage((_b, i) =>
      i === 0
        ? { end: { kind: 'incomplete', at: incompleteAt } }
        : i === 1
          ? { end: { kind: 'reject', at: rejectAt } }
          : healthy()
    )
    await advance(100)
    act(() => page.latest.card!.refreshBalance())
    const changes = await statusesUntil(page, 20_000)
    expect(failedAt(changes)).toEqual([])
    expect(changes[changes.length - 1]?.[1]).toBe('ready')
    page.unmount()
  })
})

describe('a failure that lasts shows', () => {
  it('e: everything failing from open shows the grey card at 10.7 s, and the explorer answering again ends it', async () => {
    const page = openPage(b => (b < 40_000 ? { end: { kind: 'reject', at: 50 } } : healthy()))
    const changes = await statusesUntil(page, 45_000)
    expect(page.background.began).toEqual([0, 1_550, 4_600, 10_650, 20_700, 40_750])
    // The read begun at 10.65 s is the first 10 s and more after the first
    // failed one began: as it fails, at 10.7 s, the failure shows.
    expect(failedAt(changes)).toEqual([[10_700, 'failed-empty']])
    // The read from 40.75 s answers its total at 41.05 s, and in full at
    // 41.55 s: the grey card stays through the total, and leaves for the
    // balance as that read settles without failing (item 1).
    expect(changes.slice(-2)).toEqual([
      [10_700, 'failed-empty'],
      [41_600, 'ready'],
    ])
    page.unmount()
  })

  it.each([
    ["g': statistics failing from 30 to 45 s", 45_000],
    ['h: everything failing from 30 to 90 s', 90_000],
  ])(
    '%s shows the warning at 42.2 s: reads at 30 s, 2 s after (item 4), and 10 s after that',
    async (_name, healedAt) => {
      const page = openPage(b =>
        b >= 30_000 && b < healedAt ? { end: { kind: 'reject', at: 50 } } : healthy()
      )
      const changes = await statusesUntil(page, 45_000)
      expect(page.background.began.filter(at => at >= 30_000)).toEqual([30_000, 32_050, 42_100])
      expect(failedAt(changes)).toEqual([[42_200, 'failed']])
      page.unmount()
    }
  )
})

describe('a failed state stays as it is between failed reads (item 1, N1)', () => {
  it.each<[string, (began: number) => ReadPlan, [number, string], number]>([
    [
      'one lookup failing for ever: every read answers its total, then fails',
      () => ({ totalAt: 300, end: { kind: 'incomplete', failed: true, at: 800 } }),
      [13_700, 'failed'],
      90_000,
    ],
    [
      'flap: the statistics answer and the lookups fail from 30 s, over a shown split',
      b =>
        b < 30_000
          ? healthy()
          : { totalAt: 300, end: { kind: 'incomplete', failed: true, at: 800 } },
      [44_400, 'failed'],
      150_000,
    ],
    [
      'flap from open: the statistics answer, then the read rejects',
      () => ({ totalAt: 300, end: { kind: 'reject', at: 900 } }),
      [14_100, 'failed'],
      90_000,
    ],
  ])('%s', async (_name, plan, failure, until) => {
    const page = openPage(plan)
    const changes = await statusesUntil(page, until)
    // One change into the failed state, and none after it, though reads
    // went on and told their totals.
    expect(fromFailure(changes)).toEqual([failure])
    expect(page.background.began.filter(at => at > failure[0]).length).toBeGreaterThanOrEqual(2)
    page.unmount()
  })

  it('leaves it only as a read begun after the newest failure settles without failing: lookup failing until 30 s', async () => {
    const page = openPage(b =>
      b < 30_000 ? { totalAt: 300, end: { kind: 'incomplete', failed: true, at: 800 } } : healthy()
    )
    const changes = await statusesUntil(page, 60_000)
    expect(fromFailure(changes)).toEqual([
      [13_700, 'failed'],
      [45_300, 'ready'],
    ])
    page.unmount()
  })

  it('starts the count again after an answer that made progress: one failure 60 s after another shows nothing (N14)', async () => {
    let failedLate = false
    const page = openPage((b, i) => {
      if (i === 0) return { end: { kind: 'reject', at: 50 } }
      if (b >= 60_000 && !failedLate) {
        failedLate = true
        return { end: { kind: 'reject', at: 50 } }
      }
      return { totalAt: 300, end: { kind: 'incomplete', at: 5_000 } }
    })
    const changes = await statusesUntil(page, 85_000)
    expect(failedAt(changes)).toEqual([])
    page.unmount()
  })

  it('waits for a read in flight before the 30 s rule shows the failure: slow failures healing just after it (N7)', async () => {
    const page = openPage((_b, i) =>
      i === 0
        ? { end: { kind: 'reject', at: 20_000 } }
        : i === 1
          ? { totalAt: 8_800, end: { kind: 'complete', at: 9_300 } }
          : healthy()
    )
    const changes = await statusesUntil(page, 40_000)
    expect(page.background.began.slice(0, 2)).toEqual([0, 21_500])
    expect(failedAt(changes)).toEqual([])
    expect(changes[changes.length - 1]?.[1]).toBe('ready')
    page.unmount()
  })
})

describe('a different total is shown (item 3, N3)', () => {
  it('shows the new total, its split loading, as soon as an answer that could not read every output brings it over a shown split', async () => {
    const page = openPage(b =>
      b < 20_000
        ? healthy()
        : {
            totalAt: 300,
            totalBalance: 95_000_000,
            end: { kind: 'incomplete', total: 95_000_000, at: 800 },
          }
    )
    await advance(20_700)
    // The poll's read from 20 s told its total; the split is still shown.
    expect(page.latest.card!.status.kind).not.toBe('total')
    await advance(200)
    expect(page.latest.card!.status).toMatchObject({
      kind: 'total',
      shown: { total: 95_000_000, split: { kind: 'loading' } },
    })
    const changes = await statusesUntil(page, 90_000)
    // And so it stays for as long as the reads end without every output.
    expect(changes).toEqual([[20_900, 'total']])
    page.unmount()
  })
})

describe('a value shown as out of date stays dimmed until it is fresh (item 2, N2)', () => {
  const kinds = (changes: [number, string][]) => changes.map(([, kind]) => kind)

  it('a kept answer at open while every read fails: never back to full opacity before the balance is read', async () => {
    const kept = () => Promise.resolve({ balance: complete(), readAt: OPEN - 60_000 })
    const page = openPage(b => (b < 30_000 ? { end: { kind: 'reject', at: 2_000 } } : healthy()), {
      kept,
    })
    const changes = await statusesUntil(page, 60_000)
    const seen = kinds(changes)
    const dimmedFrom = seen.indexOf('refreshing')
    expect(dimmedFrom).toBeGreaterThan(0)
    // Shown as it is only before it first dims; never again until the read
    // that answers in full.
    expect(seen.slice(dimmedFrom, -1)).not.toContain('ready')
    expect(seen[seen.length - 1]).toBe('ready')
    page.unmount()
  })

  it('a refresh the user asks for over a value dimmed after a failed read', async () => {
    const page = openPage((_b, i) =>
      i === 1
        ? { end: { kind: 'reject', at: 50 } }
        : i === 2
          ? { end: { kind: 'complete', at: 1_500 } }
          : healthy()
    )
    await advance(11_000)
    expect(page.latest.card!.status).toMatchObject({ kind: 'refreshing', reason: 'retry' })
    act(() => page.latest.card!.refreshBalance())
    const changes = await statusesUntil(page, 15_000, 10)
    // Read 1 s after the tap, it answers 1.5 s later: dimmed throughout.
    expect(page.background.began).toEqual([0, 10_000, 12_000])
    expect(changes).toEqual([
      [11_000, 'refreshing'],
      [13_500, 'ready'],
    ])
    page.unmount()
  })

  it(`stays dimmed at least 400 ms once dimmed: a refresh answering 450 ms after it began (N10)`, async () => {
    const page = openPage((_b, i) => (i === 1 ? { end: { kind: 'complete', at: 450 } } : healthy()))
    await advance(1_000)
    act(() => page.latest.card!.refreshBalance())
    const changes = await statusesUntil(page, 3_500, 10)
    expect(page.background.began).toEqual([0, 2_000])
    // Quiet for 400 ms, dimmed from then, for 400 ms, past the answer at 450.
    expect(changes).toEqual([
      [1_000, 'ready'],
      [2_400, 'refreshing'],
      [2_800, 'ready'],
    ])
    page.unmount()
  })
})

describe('a failure is not shown again before the card has read since it was seen again (A)', () => {
  const failingAt10 = (_b: number, i: number): ReadPlan =>
    i === 1 ? { end: { kind: 'reject', at: 50 } } : healthy()

  it('away to another screen for 40 s after a failed read', async () => {
    const page = openPage(failingAt10)
    await advance(10_500)
    page.showCard(false)
    await advance(40_000)
    page.showCard(true)
    // The first paint, and every one until the read begun now answers.
    expect(page.latest.card!.status.kind).not.toBe('failed')
    const changes = await statusesUntil(page, 52_000, 10)
    expect(failedAt(changes)).toEqual([])
    expect(changes[changes.length - 1]?.[1]).toBe('ready')
    page.unmount()
  })

  it('away to another account for 40 s after a failed read', async () => {
    const page = openPage(failingAt10)
    await advance(10_500)
    const select = (address: string, key: string) =>
      act(() => {
        page.store.dispatch(
          accountActions.setCurrent({
            address,
            key,
            pubkey: '11'.repeat(32),
            type: 'Qbit HD Key Tree',
          } as never)
        )
      })
    select('qbit-timeline-other', 'account-2')
    await advance(40_000)
    select(ADDRESS, 'account-1')
    expect(page.latest.card!.status.kind).not.toBe('failed')
    const changes = await statusesUntil(page, 52_000, 10)
    expect(failedAt(changes)).toEqual([])
    expect(changes[changes.length - 1]?.[1]).toBe('ready')
    page.unmount()
  })
})

describe('reads at an unlock in the page', () => {
  it('reads once at the unlock, the card taking it, then once a poll: three reads in the first 25 s (F)', async () => {
    const page = openPage(() => healthy(), { locked: true })
    expect(page.background.began).toEqual([])
    act(() => {
      page.store.dispatch(globalActions.update({ isUnlocked: true }))
    })
    await advance(300)
    page.showCard(true)
    await advance(24_700)
    expect(page.background.began).toEqual([0, 10_000, 20_000])
    page.unmount()
  })

  it('reads at the unlock when the read in flight began before the lock (item 9, N9)', async () => {
    const page = openPage((_b, i) =>
      i === 1 ? { end: { kind: 'complete', at: 3_000 } } : healthy()
    )
    await advance(11_000)
    page.showCard(false)
    act(() => {
      uiEventBus.emit(BUS_METHODS.LOCKED, {})
    })
    await advance(1_000)
    act(() => {
      page.store.dispatch(globalActions.update({ isUnlocked: true }))
    })
    await advance(200)
    page.showCard(true)
    // The poll's read from 10 s is from before the lock: the account is read
    // at the unlock, and the card shows that read's answer.
    expect(page.background.began).toEqual([0, 10_000, 12_000])
    await advance(700)
    expect(page.latest.card!.status).toMatchObject({ kind: 'ready', busy: false })
    // The read from before the lock answers later, and changes nothing.
    await advance(1_000)
    expect(page.latest.card!.status).toMatchObject({ kind: 'ready', busy: false })
    page.unmount()
  })

  it('shows what it read before a lock dimmed after the unlock, until the read begun then answers (B)', async () => {
    const page = openPage((_b, i) =>
      i === 1 ? { end: { kind: 'complete', at: 2_000 } } : healthy()
    )
    await advance(1_000)
    expect(page.latest.card!.status.kind).toBe('ready')

    // The wallet locks; the home screen goes, and comes back at the unlock.
    page.showCard(false)
    act(() => {
      uiEventBus.emit(BUS_METHODS.LOCKED, {})
    })
    await advance(1_000)
    act(() => {
      page.store.dispatch(globalActions.update({ isUnlocked: true }))
    })
    page.showCard(true)
    // The read begun at the unlock is the card's: no other read.
    expect(page.background.began).toEqual([0, 2_000])
    // Dimmed at once while that read runs: no quiet start for a value from
    // before a lock (item 5).
    expect(page.latest.card!.status).toMatchObject({
      kind: 'refreshing',
      reason: 'cached',
      busy: true,
    })
    await advance(400)
    expect(page.latest.card!.status).toMatchObject({ kind: 'refreshing', reason: 'cached' })
    await advance(1_600)
    expect(page.latest.card!.status).toMatchObject({ kind: 'ready', busy: false })
    page.unmount()
  })
})

describe('a fast answer never flashes the dimming (C)', () => {
  const dimmed = (changes: [number, string][]) =>
    changes.filter(([, kind]) => kind === 'refreshing')

  it('on a re-open with a kept answer and a fast explorer', async () => {
    const kept = () => Promise.resolve({ balance: complete(), readAt: OPEN - 60_000 })
    const page = openPage(() => ({ totalAt: 100, end: { kind: 'complete', at: 300 } }), { kept })
    const changes = await statusesUntil(page, 2_000)
    expect(dimmed(changes)).toEqual([])
    page.unmount()
  })

  it('on a fast refresh the user asked for', async () => {
    const page = openPage(() => ({ end: { kind: 'complete', at: 300 } }))
    await advance(1_000)
    act(() => page.latest.card!.refreshBalance())
    // The refresh reads 1 s after the tap and answers 0.3 s later.
    const changes = await statusesUntil(page, 3_000)
    expect(page.background.began).toEqual([0, 2_000])
    expect(dimmed(changes)).toEqual([])
    page.unmount()
  })
})

describe('a read the card gives up on (item 7)', () => {
  it('counts as a failed read: a dead background shows the load error once it is given up on, and keeps it as the next read begins', async () => {
    const page = openPage(() => ({ end: { kind: 'never' } }))
    const changes = await statusesUntil(page, 130_000)
    // The next read, from 70 s, never answers either: nothing changes.
    expect(page.background.began).toEqual([0, 70_000])
    expect(fromFailure(changes)).toEqual([[60_000, 'failed-empty']])
    page.unmount()
  })
})

describe('a failure on screen stays until a read settles (round 3, item 1)', () => {
  // Healthy, then everything failing from 30 s, healed at `healedAt`: the
  // warning from 42.2 s (reads at 30, 32.05 and 42.1 s), the next poll 20 s
  // after the third failure, at 62.15 s.
  const outage = (healedAt: number) => (b: number) =>
    b >= 30_000 && b < healedAt ? { end: { kind: 'reject' as const, at: 50 } } : healthy()

  it('reads at once when the page is shown again, and keeps the failure until that read settles', async () => {
    const page = openPage(outage(48_000))
    await advance(45_000)
    expect(page.latest.card!.status.kind).toBe('failed')
    page.setPageHidden(true)
    await advance(5_000)
    page.setPageHidden(false)
    const changes = await statusesUntil(page, 55_000, 50)
    // Read at 50 s, not at 62.15 s; failed, busy, until it answers at 50.8 s.
    expect(page.background.began.filter(at => at >= 45_000)).toEqual([50_000])
    expect(changes).toEqual([
      [50_000, 'failed'],
      [50_800, 'ready'],
    ])
    page.unmount()
  })

  it('keeps it when the card is shown again after another screen, until the read begun then settles', async () => {
    const page = openPage(outage(60_000))
    await advance(45_000)
    expect(page.latest.card!.status.kind).toBe('failed')
    page.showCard(false)
    await advance(20_000)
    page.showCard(true)
    // The first paint and every one until the read begun at 65 s answers.
    expect(page.latest.card!.status.kind).toBe('failed')
    const changes = await statusesUntil(page, 70_000, 50)
    expect(page.background.began.filter(at => at >= 45_000)).toEqual([65_000])
    expect(changes).toEqual([
      [65_000, 'failed'],
      [65_800, 'ready'],
    ])
    page.unmount()
  })

  it('keeps it when the account is selected again after another, until the read begun then settles', async () => {
    const page = openPage(outage(60_000))
    await advance(45_000)
    expect(page.latest.card!.status.kind).toBe('failed')
    const select = (address: string, key: string) =>
      act(() => {
        page.store.dispatch(
          accountActions.setCurrent({
            address,
            key,
            pubkey: '11'.repeat(32),
            type: 'Qbit HD Key Tree',
          } as never)
        )
      })
    select('qbit-timeline-other', 'account-2')
    await advance(20_000)
    select(ADDRESS, 'account-1')
    expect(page.latest.card!.status.kind).toBe('failed')
    const changes = await statusesUntil(page, 70_000, 50)
    expect(changes).toEqual([
      [65_000, 'failed'],
      [65_800, 'ready'],
    ])
    page.unmount()
  })
})

describe('no failure that shows and heals within moments (round 3, item 3)', () => {
  it('waits for a read about to begin: a failure, a slow failed read, the next read 2 s after the 30 s are up', async () => {
    // The read at 30 s rejects; the one 2 s later fails to read the outputs
    // at its 20 s deadline; the next, 10 s after that (62.05 s), answers.
    const page = openPage((b, i) =>
      b < 30_000 || b >= 60_000
        ? healthy()
        : i === 3
          ? { end: { kind: 'reject', at: 50 } }
          : { totalAt: 300, end: { kind: 'incomplete', failed: true, at: 20_000 } }
    )
    const changes = await statusesUntil(page, 70_000)
    expect(page.background.began.filter(at => at >= 30_000)).toEqual([30_000, 32_050, 62_050])
    expect(failedAt(changes)).toEqual([])
    expect(changes[changes.length - 1]?.[1]).toBe('ready')
    page.unmount()
  })

  it('waits for a refresh queued behind a read given up on, which begins at the give-up', async () => {
    // The poll's read from 10 s never answers; a refresh from another
    // screen at 10.5 s waits for it, and begins as the card gives up at 70 s.
    const page = openPage((_b, i) => (i === 1 ? { end: { kind: 'never' } } : healthy()))
    await advance(10_500)
    page.refreshFromElsewhere()
    const changes = await statusesUntil(page, 75_000)
    expect(page.background.began).toEqual([0, 10_000, 70_000])
    expect(failedAt(changes)).toEqual([])
    expect(changes[changes.length - 1]?.[1]).toBe('ready')
    page.unmount()
  })
})

describe('busy only while reading, and a passing failure short (round 3, item 4)', () => {
  it('dims the value for the 2 s until the read after a failed poll, the ring turning only as that read comes', async () => {
    const page = openPage((_b, i) => (i === 3 ? { end: { kind: 'reject', at: 50 } } : healthy()))
    await advance(30_500)
    expect(page.latest.card!.status).toMatchObject({
      kind: 'refreshing',
      reason: 'retry',
      busy: false,
    })
    expect(page.latest.card!.statusText).toBeUndefined()
    await advance(1_000)
    expect(page.latest.card!.status).toMatchObject({ kind: 'refreshing', busy: true })
    expect(page.latest.card!.statusText).toBe('balance_updating')
    await advance(1_400)
    expect(page.background.began.slice(3)).toEqual([30_000, 32_050])
    expect(page.latest.card!.status).toMatchObject({ kind: 'ready', busy: false })
    page.unmount()
  })
})

describe('the poll tells the card when its schedule changes (round 4, item 3)', () => {
  it('turns the ring a second before the read after a failed poll, though the page renders the failure before the poll has scheduled that read', async () => {
    const page = openPage((_b, i) => (i === 3 ? { end: { kind: 'reject', at: 50 } } : healthy()))
    await advance(30_000)
    // As in the page: each change of the store renders at once, so the
    // render after the failure is recorded comes before the card's poll
    // hears of it and schedules the next read.
    const unsubscribe = page.store.subscribe(() => flushSync(() => undefined))
    await advance(500)
    unsubscribe()
    expect(page.latest.card!.status).toMatchObject({
      kind: 'refreshing',
      reason: 'retry',
      busy: false,
    })
    await advance(1_000)
    expect(page.latest.card!.status).toMatchObject({ kind: 'refreshing', busy: true })
    expect(page.latest.card!.statusText).toBe('balance_updating')
    await advance(1_400)
    expect(page.background.began.slice(3)).toEqual([30_000, 32_050])
    page.unmount()
  })
})

describe('the value from before a lock (round 3, item 5)', () => {
  it('is dimmed at once after the unlock, with nothing shown at full opacity before the read begun then answers', async () => {
    const page = openPage((_b, i) =>
      i === 1 ? { end: { kind: 'complete', at: 2_000 } } : healthy()
    )
    await advance(1_000)
    page.showCard(false)
    act(() => {
      uiEventBus.emit(BUS_METHODS.LOCKED, {})
    })
    await advance(1_000)
    act(() => {
      page.store.dispatch(globalActions.update({ isUnlocked: true }))
    })
    page.showCard(true)
    const changes = await statusesUntil(page, 4_500, 10)
    expect(changes).toEqual([
      [2_000, 'refreshing'],
      [4_000, 'ready'],
    ])
    page.unmount()
  })
})
