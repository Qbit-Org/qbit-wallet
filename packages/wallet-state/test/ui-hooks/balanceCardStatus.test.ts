import { describe, expect, it } from 'vitest'
import { ChainType } from '@qbit/wallet-types'

import type { BalanceReadRecord } from '../../src/reducers/accounts'
import {
  BALANCE_DIMMED_AT_LEAST_MS,
  BALANCE_READ_ABOUT_TO_BEGIN_MS,
  BALANCE_QUIET_REFRESH_MS,
  BALANCE_READ_DEADLINE_MS,
  BALANCE_ESCALATE_AFTER_MS,
  BALANCE_ESCALATE_SPREAD_MS,
  BALANCE_PROGRESS_AFTER_MS,
  BALANCE_QUIET_POLL_MS,
  balanceCardMessage,
  balanceCardStatus,
  hiddenWithin,
  pruneHiddenSpans,
  type BalanceCardFacts,
  type VisibilityHistory,
  type BalanceCardStatus,
} from '../../src/ui-hooks/useBalanceCardLogic'

const chainType = ChainType.QBIT_MAINNET
const complete = {
  availableBalance: 60_000_000,
  unavailableBalance: 31_000_000,
  totalBalance: 91_000_000,
  chainType,
}
const incomplete = {
  availableBalance: null,
  unavailableBalance: 92_000_000,
  totalBalance: 92_000_000,
  utxoReadIncomplete: true,
  chainType,
}
const guardBusy = {
  availableBalance: null,
  unavailableBalance: 91_000_000,
  totalBalance: 91_000_000,
  chainType,
}
const overLimit = { ...guardBusy, utxoLimitExceeded: true }
const kept = { balance: { ...complete, totalBalance: 90_000_000 }, readAt: 0 }

const T = 1_000_000
const facts = (over: Partial<BalanceCardFacts> = {}): BalanceCardFacts => ({
  chainType,
  own: undefined,
  kept: undefined,
  record: undefined,
  hidden: false,
  ...over,
})
const reading = (startedAt = T, byUser = false): BalanceReadRecord['reading'] => ({
  requestId: 5,
  chainType,
  startedAt,
  byUser,
})
const outcome = (
  kind: 'complete' | 'partial' | 'failed',
  requestId = 4,
  startedAt?: number
): BalanceReadRecord['outcome'] => ({
  requestId,
  chainType,
  kind,
  ...(startedAt !== undefined ? { startedAt } : {}),
})
/** Failed reads 1, 2, … begun at `starts`. */
const failures = (...starts: number[]): BalanceReadRecord['failed'] => ({
  chainType,
  reads: starts.map((startedAt, index) => ({ requestId: index + 1, startedAt })),
})

describe('balanceCardStatus', () => {
  it('loads with nothing known', () => {
    expect(balanceCardStatus(facts({ record: { reading: reading() } }), T).status).toEqual({
      kind: 'loading',
      hidden: false,
      busy: true,
    })
  })

  it('shows the total with the split loading once the statistics answered', () => {
    const record = {
      reading: reading(),
      early: { requestId: 5, chainType, totalBalance: 92_000_000 },
    }
    expect(balanceCardStatus(facts({ record }), T).status).toEqual({
      kind: 'total',
      shown: {
        total: 92_000_000,
        split: { kind: 'loading' },
        limitExceeded: false,
        source: 'early',
      },
      hidden: false,
      busy: true,
    })
  })

  it.each([
    ['an incomplete answer', incomplete],
    ['an answer the send guard left without a split (#124)', guardBusy],
  ])('shows the total with the split loading, never `--`, for %s', (_case, own) => {
    expect(balanceCardStatus(facts({ own: own as never }), T).status).toMatchObject({
      kind: 'total',
      shown: { split: { kind: 'loading' }, source: 'own' },
    })
  })

  it('is ready with a complete answer, and with the explorer limit, a lasting cause it states', () => {
    expect(balanceCardStatus(facts({ own: complete }), T).status).toEqual({
      kind: 'ready',
      shown: {
        total: 91_000_000,
        split: { kind: 'known', available: 60_000_000, unavailable: 31_000_000 },
        limitExceeded: false,
        source: 'own',
      },
      hidden: false,
      busy: false,
    })
    expect(balanceCardStatus(facts({ own: overLimit as never }), T).status).toMatchObject({
      kind: 'ready',
      shown: { split: { kind: 'limit' }, limitExceeded: true },
    })
  })

  it(`refreshes from the cache at open once the read has run ${BALANCE_QUIET_REFRESH_MS} ms, the kept answer shown as it is before`, () => {
    const record = { reading: reading() }
    const first = balanceCardStatus(facts({ kept, record }), T + BALANCE_QUIET_REFRESH_MS - 1)
    expect(first.status).toMatchObject({ kind: 'ready', shown: { source: 'kept' }, busy: true })
    expect(first.nextChangeAt).toBe(T + BALANCE_QUIET_REFRESH_MS)
    expect(
      balanceCardStatus(facts({ kept, record }), T + BALANCE_QUIET_REFRESH_MS).status
    ).toMatchObject({
      kind: 'refreshing',
      reason: 'cached',
      shown: { total: 90_000_000, source: 'kept' },
      busy: true,
    })
    // With no read in flight, at once.
    expect(balanceCardStatus(facts({ kept }), T).status).toMatchObject({
      kind: 'refreshing',
      reason: 'cached',
    })
  })

  it(`refreshes for the user once the read has run ${BALANCE_QUIET_REFRESH_MS} ms, and after a failed read at once`, () => {
    const user = { reading: reading(T, true) }
    expect(
      balanceCardStatus(facts({ own: complete, record: user }), T + BALANCE_QUIET_REFRESH_MS - 1)
        .status
    ).toMatchObject({ kind: 'ready', busy: true })
    expect(
      balanceCardStatus(facts({ own: complete, record: user }), T + BALANCE_QUIET_REFRESH_MS).status
    ).toMatchObject({ kind: 'refreshing', reason: 'user' })
    const afterFailure = {
      reading: reading(),
      outcome: outcome('failed', 1, T - 5_000),
      failed: failures(T - 5_000),
    }
    expect(
      balanceCardStatus(facts({ own: complete, record: afterFailure }), T).status
    ).toMatchObject({
      kind: 'refreshing',
      reason: 'retry',
    })
    // Waiting for the next read after it, as well: still dimmed, but busy
    // (the ring, "Updating…") only once that read is due within a second.
    const waiting = facts({ own: complete, record: { outcome: outcome('partial') } })
    const idle = balanceCardStatus({ ...waiting, nextReadAt: T + 5_000 }, T)
    expect(idle.status).toMatchObject({ kind: 'refreshing', reason: 'retry', busy: false })
    expect(balanceCardMessage(idle.status)).toBeUndefined()
    expect(idle.nextChangeAt).toBe(T + 4_000)
    const due = balanceCardStatus({ ...waiting, nextReadAt: T + 5_000 }, T + 4_000).status
    expect(due).toMatchObject({ kind: 'refreshing', reason: 'retry', busy: true })
    expect(balanceCardMessage(due)).toBe('updating')
  })

  it(`shows a background poll only once it has run ${BALANCE_QUIET_POLL_MS} ms`, () => {
    const record = { reading: reading(T) }
    const quiet = balanceCardStatus(facts({ own: complete, record }), T + BALANCE_QUIET_POLL_MS - 1)
    expect(quiet.status).toMatchObject({ kind: 'ready', busy: false })
    expect(quiet.nextChangeAt).toBe(T + BALANCE_QUIET_POLL_MS)
    expect(
      balanceCardStatus(facts({ own: complete, record }), T + BALANCE_QUIET_POLL_MS).status
    ).toMatchObject({ kind: 'refreshing', reason: 'poll' })
  })

  it(`shows how far a read has got once it has run ${BALANCE_PROGRESS_AFTER_MS} ms`, () => {
    const record = {
      reading: reading(T),
      early: { requestId: 5, chainType, totalBalance: 92_000_000, read: 1_240, total: 3_346 },
    }
    const early = balanceCardStatus(facts({ record }), T + BALANCE_PROGRESS_AFTER_MS - 1)
    expect(early.status).toMatchObject({ kind: 'total' })
    expect(early.status).not.toHaveProperty('progress')
    expect(early.nextChangeAt).toBe(T + BALANCE_PROGRESS_AFTER_MS)
    expect(
      balanceCardStatus(facts({ record }), T + BALANCE_PROGRESS_AFTER_MS).status
    ).toMatchObject({
      kind: 'total',
      progress: { read: 1_240, total: 3_346 },
    })
  })

  describe('escalating a failure', () => {
    const failed = (...starts: number[]) => ({
      outcome: outcome('failed', starts.length, starts[starts.length - 1]),
      failed: failures(...starts),
    })

    it(`shows two failed reads only when the later began ${BALANCE_ESCALATE_SPREAD_MS} ms or more after the first`, () => {
      const close = balanceCardStatus(
        facts({ record: failed(T, T + BALANCE_ESCALATE_SPREAD_MS - 1) }),
        T + 10_100
      )
      expect(close.status.kind).toBe('loading')
      // Decided as the reads settle, not by a timer: only the 30 s clock waits.
      expect(close.nextChangeAt).toBe(T + BALANCE_ESCALATE_AFTER_MS)
      expect(
        balanceCardStatus(facts({ record: failed(T, T + BALANCE_ESCALATE_SPREAD_MS) }), T + 10_100)
          .status
      ).toEqual({ kind: 'failed-empty', hidden: false, busy: false })
    })

    it(`shows one failed read ${BALANCE_ESCALATE_AFTER_MS} ms after it began`, () => {
      const record = failed(T)
      const before = balanceCardStatus(facts({ record }), T + BALANCE_ESCALATE_AFTER_MS - 1)
      expect(before.status.kind).toBe('loading')
      expect(before.nextChangeAt).toBe(T + BALANCE_ESCALATE_AFTER_MS)
      expect(balanceCardStatus(facts({ record }), T + BALANCE_ESCALATE_AFTER_MS).status.kind).toBe(
        'failed-empty'
      )
    })

    it('counts the 30 s from the first failed read, never from a partial answer before it', () => {
      // Partial answers for a minute (a large account read through), then one failure.
      const record = {
        outcome: outcome('failed', 9, T + 60_000),
        failed: { chainType, reads: [{ requestId: 9, startedAt: T + 60_000 }] },
      }
      expect(
        balanceCardStatus(facts({ own: incomplete as never, record }), T + 61_000).status.kind
      ).toBe('total')
    })

    it('does not count the time the page was hidden', () => {
      const record = failed(T)
      const hiddenSpans = [[T + 5_000, T + 25_000]] as const
      const status = balanceCardStatus(facts({ record, hiddenSpans }), T + 40_000)
      expect(status.status.kind).toBe('loading')
      expect(status.nextChangeAt).toBe(T + 50_000)
      // Still hidden: nothing escalates, and no timer is needed.
      const stillHidden = balanceCardStatus(
        facts({ record, hiddenSpans: [[T + 5_000, undefined]] }),
        T + 60_000
      )
      expect(stillHidden.status.kind).toBe('loading')
      expect(stillHidden.nextChangeAt).toBeUndefined()
    })

    it('waits, on a page shown again, for a read begun since to settle (F10)', () => {
      const hiddenSpans = [[T + 31_000, T + 40_000]] as const
      const shownAt = T + 40_000
      expect(
        balanceCardStatus(facts({ record: failed(T), hiddenSpans, shownAt }), T + 40_500).status
          .kind
      ).toBe('loading')
      // The read begun as it was shown failed too: now it shows.
      const record = { ...failed(T, T + 40_000), outcome: outcome('failed', 2, T + 40_000) }
      expect(
        balanceCardStatus(facts({ record, hiddenSpans, shownAt }), T + 40_600).status.kind
      ).toBe('failed-empty')
    })

    it('shows two failures over a shown value, which stays', () => {
      const record = { ...failed(T, T + 10_000), reading: reading(T + 11_000) }
      expect(balanceCardStatus(facts({ own: complete, record }), T + 11_000).status).toMatchObject({
        kind: 'failed',
        shown: { total: 91_000_000, split: { kind: 'known' } },
        busy: true,
      })
    })

    it('stays as it is through a newer read in flight, its early total and count included (item 1)', () => {
      const inFlight = {
        ...failed(T, T + 10_000),
        reading: { requestId: 3, chainType, startedAt: T + 11_000, byUser: false },
        early: { requestId: 3, chainType, totalBalance: 92_000_000, read: 10, total: 20 },
      }
      // Nothing shown: the grey card stays.
      expect(balanceCardStatus(facts({ record: inFlight }), T + 15_000).status).toEqual({
        kind: 'failed-empty',
        hidden: false,
        busy: true,
      })
      // Over a split, or the total of the read that failed: the same value stays.
      expect(
        balanceCardStatus(facts({ own: complete, record: inFlight }), T + 15_000).status
      ).toMatchObject({ kind: 'failed', shown: { total: 91_000_000, split: { kind: 'known' } } })
      const settledTotal = { requestId: 2, chainType, totalBalance: 90_000_000 }
      expect(
        balanceCardStatus(facts({ record: { ...inFlight, settledTotal } }), T + 15_000).status
      ).toMatchObject({ kind: 'failed', shown: { total: 90_000_000, split: { kind: 'loading' } } })
      // Without the failures (a read begun after them settled without
      // failing), the read in flight shows as usual.
      const { failed: _ended, ...healed } = inFlight
      expect(balanceCardStatus(facts({ record: healed }), T + 15_000).status).toMatchObject({
        kind: 'total',
        shown: { total: 92_000_000 },
        progress: { read: 10, total: 20 },
      })
    })

    it(`waits for a read begun after the latest failure while it is within the background's ${BALANCE_READ_DEADLINE_MS} ms (item 7)`, () => {
      const record = {
        ...failed(T),
        reading: { requestId: 2, chainType, startedAt: T + 21_500, byUser: false },
      }
      const due = balanceCardStatus(facts({ record }), T + BALANCE_ESCALATE_AFTER_MS)
      expect(due.status.kind).toBe('loading')
      expect(due.nextChangeAt).toBe(T + 21_500 + BALANCE_READ_DEADLINE_MS)
      expect(
        balanceCardStatus(facts({ record }), T + 21_500 + BALANCE_READ_DEADLINE_MS).status.kind
      ).toBe('failed-empty')
      // A read begun once the 30 s were up: waited for too while the
      // failure has not been shown (item 3); one shown stays (item 1).
      const late = {
        ...failed(T),
        reading: { requestId: 2, chainType, startedAt: T + 40_000, byUser: false },
      }
      expect(balanceCardStatus(facts({ record: late }), T + 40_100).status.kind).toBe('loading')
      expect(
        balanceCardStatus(facts({ record: late, failureShown: true }), T + 40_100).status.kind
      ).toBe('failed-empty')
      // A read that began before the latest failure is no reason to wait.
      const older = { ...failed(T, T + 2_000), reading: reading(T + 1_000) }
      older.reading = { ...older.reading!, requestId: 1 }
      expect(
        balanceCardStatus(facts({ record: older }), T + BALANCE_ESCALATE_AFTER_MS).status.kind
      ).toBe('failed-empty')
    })

    it('does not count the time the page was hidden in the spread between failed reads either (item 8)', () => {
      const record = failed(T, T + 60_000)
      const hiddenSpans = [[T + 5_000, T + 58_000]] as const
      const status = balanceCardStatus(facts({ record, hiddenSpans }), T + 60_100)
      // 7 s of shown time between them, 7.1 s since the first.
      expect(status.status.kind).toBe('loading')
      expect(status.nextChangeAt).toBe(T + 60_100 + BALANCE_ESCALATE_AFTER_MS - 7_100)
      expect(
        balanceCardStatus(facts({ record, hiddenSpans: [[T + 5_000, T + 49_000]] }), T + 60_100)
          .status.kind
      ).toBe('failed-empty')
    })

    it('counts spans folded into one as hidden for what of them is covered (E)', () => {
      const spans = [[T, T + 10_000, 6_000] as const, [T + 20_000, T + 21_000] as const]
      expect(hiddenWithin(spans, T, T + 30_000)).toBe(7_000)
      expect(hiddenWithin(spans, T + 5_000, T + 30_000)).toBe(4_000)
      expect(hiddenWithin(spans, T + 10_000, T + 20_500)).toBe(500)
    })

    it('folds old hidden spans into one instead of dropping them: a hundred hide-and-show cycles in one failure count every hidden second (E)', () => {
      const history: VisibilityHistory = { spans: [] }
      // Hidden 1 s in every 1.5 s, from the failed read on, and a span that
      // ended before it, which no failure counted reaches.
      history.spans.push([T - 5_000, T - 4_000])
      for (let cycle = 0; cycle < 100; cycle += 1) {
        history.spans.push([T + cycle * 1_500, T + cycle * 1_500 + 1_000])
        pruneHiddenSpans(history, T)
      }
      expect(history.spans.length).toBeLessThanOrEqual(32)
      expect(hiddenWithin(history.spans, T - 10_000, T + 150_000)).toBe(100_000)
      const record = failed(T)
      // 75 s on, about 25 s of it shown: no failure yet; 150 s on, 50 s shown.
      expect(
        balanceCardStatus(facts({ record, hiddenSpans: history.spans }), T + 75_000).status.kind
      ).toBe('loading')
      expect(
        balanceCardStatus(facts({ record, hiddenSpans: history.spans }), T + 150_000).status.kind
      ).toBe('failed-empty')
    })

    it('keeps a failure the card has shown, whatever is read and wherever the user went since (round 3, item 1)', () => {
      const record = {
        ...failed(T, T + 12_000),
        reading: { requestId: 3, chainType, startedAt: T + 40_000, byUser: false },
      }
      // Shown again at 40 s, the read begun then in flight: a failure not yet
      // shown waits for it; one shown stays.
      const seen = { record, own: complete, shownAt: T + 40_000 }
      expect(balanceCardStatus(facts(seen), T + 40_100).status.kind).toBe('refreshing')
      expect(
        balanceCardStatus(facts({ ...seen, failureShown: true }), T + 40_100).status
      ).toMatchObject({ kind: 'failed', busy: true })
    })

    it(`waits for a read about to begin, due within ${BALANCE_READ_ABOUT_TO_BEGIN_MS} ms, before the 30 s rule shows a failure (round 3, item 3)`, () => {
      const record = failed(T)
      const at30 = T + BALANCE_ESCALATE_AFTER_MS
      const soon = balanceCardStatus(facts({ record, nextReadAt: at30 + 2_000 }), at30)
      expect(soon.status.kind).toBe('loading')
      // Next: the ring turns a second before that read is due.
      expect(soon.nextChangeAt).toBe(at30 + 1_000)
      // Due a moment ago, its start not yet recorded: still about to begin.
      expect(balanceCardStatus(facts({ record, nextReadAt: at30 - 500 }), at30).status.kind).toBe(
        'loading'
      )
      // Further off, or long overdue: the failure shows.
      expect(
        balanceCardStatus(
          facts({ record, nextReadAt: at30 + BALANCE_READ_ABOUT_TO_BEGIN_MS + 1 }),
          at30
        ).status.kind
      ).toBe('failed-empty')
      expect(balanceCardStatus(facts({ record, nextReadAt: at30 - 1_500 }), at30).status.kind).toBe(
        'failed-empty'
      )
    })

    it('says whether a total shown under a failure is the newest read’s own, its statistics answered (O4)', () => {
      // The newest read told its total, then failed (its outputs, or after them).
      const told = {
        ...failed(T, T + 10_000),
        settledTotal: { requestId: 2, chainType, totalBalance: 92_000_000 },
      }
      expect(balanceCardStatus(facts({ record: told }), T + 11_000).status).toMatchObject({
        kind: 'failed',
        shown: { total: 92_000_000, split: { kind: 'loading' } },
        totalCurrent: true,
      })
      // The newest read failed before its statistics answered: an older total.
      const older = { ...told, settledTotal: { ...told.settledTotal, requestId: 1 } }
      expect(balanceCardStatus(facts({ record: older }), T + 11_000).status).toMatchObject({
        kind: 'failed',
        totalCurrent: false,
      })
    })

    it('waits, on a card shown or an account selected again, for a read begun since to settle, on both rules (A)', () => {
      const shownAt = T + 40_000
      for (const record of [failed(T), failed(T, T + 12_000)]) {
        const waiting = balanceCardStatus(facts({ own: complete, record, shownAt }), T + 40_100)
        expect(waiting.status.kind).not.toBe('failed')
        // Seen since before the first failure: no wait.
        expect(
          balanceCardStatus(facts({ own: complete, record, shownAt: T }), T + 40_100).status.kind
        ).toBe('failed')
      }
      // The read begun as it was shown failed too: now it shows.
      const record = { ...failed(T, T + 40_000), outcome: outcome('failed', 2, T + 40_000) }
      expect(
        balanceCardStatus(facts({ own: complete, record, shownAt }), T + 40_600).status.kind
      ).toBe('failed')
    })

    it('clears with a complete answer', () => {
      expect(
        balanceCardStatus(facts({ own: complete, record: { outcome: outcome('complete') } }), T)
          .status.kind
      ).toBe('ready')
    })

    it('shows none for answers that are only partial, however long they take', () => {
      expect(
        balanceCardStatus(
          facts({ own: incomplete as never, record: { outcome: outcome('partial', 4, T) } }),
          T + 600_000
        ).status.kind
      ).toBe('total')
    })
  })

  describe('what is shown under a passing answer', () => {
    const split = (total: number, source: 'own' | 'kept' = 'own') => ({
      chainType,
      source,
      requestId: source === 'own' ? 1 : -1,
      balance: { ...complete, totalBalance: total },
    })
    const guardBusy = {
      availableBalance: null,
      unavailableBalance: 91_000_000,
      totalBalance: 91_000_000,
      chainType,
    }

    it('keeps the last split of its own, dimmed, while the newest total equals it', () => {
      expect(
        balanceCardStatus(
          facts({ own: guardBusy as never, record: { split: split(91_000_000) } }),
          T
        ).status
      ).toMatchObject({
        kind: 'refreshing',
        reason: 'retry',
        shown: { source: 'last', split: { kind: 'known' } },
      })
    })

    it('shows the newest total with the split loading once it differs', () => {
      expect(
        balanceCardStatus(
          facts({ own: guardBusy as never, record: { split: split(90_000_000) } }),
          T
        ).status
      ).toMatchObject({ kind: 'total', shown: { total: 91_000_000, split: { kind: 'loading' } } })
    })

    it('keeps the kept split, as cached, under an answer of the same total', () => {
      expect(
        balanceCardStatus(
          facts({ own: guardBusy as never, record: { split: split(91_000_000, 'kept') } }),
          T
        ).status
      ).toMatchObject({ kind: 'refreshing', reason: 'cached', shown: { source: 'kept' } })
    })
  })

  describe('a total that differs from the complete answer shown (item 3)', () => {
    const ownSplit = { chainType, source: 'own' as const, requestId: 4, balance: complete }
    const newer = (totalBalance: number, requestId = 5) => ({ requestId, chainType, totalBalance })

    it('shows the total of a newer settled read, its split loading, in place of a complete answer of another total', () => {
      const record = {
        split: ownSplit,
        outcome: outcome('partial', 5, T),
        settledTotal: newer(92_000_000),
      }
      expect(balanceCardStatus(facts({ own: complete, record }), T + 1_000).status).toMatchObject({
        kind: 'total',
        shown: { total: 92_000_000, split: { kind: 'loading' } },
      })
      // The same total: the split stays, dimmed.
      expect(
        balanceCardStatus(
          facts({ own: complete, record: { ...record, settledTotal: newer(91_000_000) } }),
          T + 1_000
        ).status
      ).toMatchObject({
        kind: 'refreshing',
        reason: 'retry',
        shown: { total: 91_000_000, split: { kind: 'known' } },
      })
      // An older read's total: the complete answer stands.
      expect(
        balanceCardStatus(
          facts({
            own: complete,
            record: {
              split: ownSplit,
              outcome: outcome('complete', 4, T),
              settledTotal: newer(92_000_000, 3),
            },
          }),
          T + 1_000
        ).status.kind
      ).toBe('ready')
    })

    it('never shows a total in flight over a complete answer: a poll changes nothing until it settles', () => {
      const record = {
        split: ownSplit,
        outcome: outcome('complete', 4, T),
        settledTotal: newer(91_000_000, 4),
        reading: reading(T),
        early: { requestId: 5, chainType, totalBalance: 92_000_000 },
      }
      expect(balanceCardStatus(facts({ own: complete, record }), T + 500).status).toMatchObject({
        kind: 'ready',
        shown: { total: 91_000_000, split: { kind: 'known' } },
      })
    })
  })

  describe('dimming (items 2 and 10)', () => {
    it('gives no quiet start over a value the card has dimmed already: it stays dimmed until a fresh complete answer', () => {
      const dimmed = { since: T - 5_000, reason: 'retry' as const }
      const done = {
        split: { chainType, source: 'own' as const, requestId: 4, balance: complete },
        outcome: outcome('complete'),
      }
      // The control turns from the start of a read the user asked for, and
      // of one over a cached value; a background poll's only after a second.
      const cases: [Partial<BalanceCardFacts>, string, boolean][] = [
        [{ kept, record: { reading: reading(T) } }, 'cached', true],
        [{ own: complete, record: { ...done, reading: reading(T, true) } }, 'user', true],
        [{ own: complete, record: { ...done, reading: reading(T) } }, 'poll', false],
      ]
      for (const [over, reason, busy] of cases) {
        expect(balanceCardStatus(facts(over), T + 100).status).toMatchObject({
          kind: 'ready',
          busy,
        })
        expect(balanceCardStatus(facts({ ...over, dimmed }), T + 100).status).toMatchObject({
          kind: 'refreshing',
          reason,
        })
      }
    })

    it(`keeps a value dimmed at least ${BALANCE_DIMMED_AT_LEAST_MS} ms, with nothing turning, before a fresh answer shows`, () => {
      const record = {
        split: { chainType, source: 'own' as const, requestId: 4, balance: complete },
        outcome: outcome('complete'),
      }
      const dimmed = { since: T, reason: 'user' as const }
      const held = balanceCardStatus(facts({ own: complete, record, dimmed }), T + 100)
      expect(held.status).toMatchObject({ kind: 'refreshing', reason: 'user', busy: false })
      expect(held.nextChangeAt).toBe(T + BALANCE_DIMMED_AT_LEAST_MS)
      expect(
        balanceCardStatus(facts({ own: complete, record, dimmed }), T + BALANCE_DIMMED_AT_LEAST_MS)
          .status.kind
      ).toBe('ready')
    })
  })

  it('shows an answer from before a lock as cached until a complete answer of a read begun after it', () => {
    const split = { chainType, source: 'own' as const, requestId: 3, balance: complete }
    const beforeLock = { split, staleUpTo: 3, reading: reading(T) }
    expect(
      balanceCardStatus(facts({ own: complete, record: beforeLock }), T + BALANCE_QUIET_REFRESH_MS)
        .status
    ).toMatchObject({ kind: 'refreshing', reason: 'cached', shown: { source: 'own' } })
    // The read after the unlock failed: still dimmed, at once.
    expect(
      balanceCardStatus(
        facts({ own: complete, record: { split, staleUpTo: 3, outcome: outcome('failed', 5) } }),
        T
      ).status
    ).toMatchObject({ kind: 'refreshing', reason: 'cached' })
    // Its complete answer (the reducer drops `staleUpTo` with it): ready.
    expect(
      balanceCardStatus(
        facts({ own: complete, record: { split: { ...split, requestId: 5 }, staleUpTo: 3 } }),
        T
      ).status.kind
    ).toBe('ready')
  })

  it('dims a value from before a lock at once, with no quiet start, a total alone included; the kept answer at open keeps it (round 3, item 5)', () => {
    const preLock = {
      split: { chainType, source: 'own' as const, requestId: 2, balance: complete },
      outcome: outcome('complete', 2),
      staleUpTo: 2,
      reading: reading(T),
    }
    expect(
      balanceCardStatus(facts({ own: complete, record: preLock }), T + 100).status
    ).toMatchObject({
      kind: 'refreshing',
      reason: 'cached',
    })
    // A total alone from before the lock, and no total from a read since.
    const totalOnly = {
      outcome: outcome('partial', 2),
      settledTotal: { requestId: 2, chainType, totalBalance: 92_000_000 },
      staleUpTo: 2,
      reading: reading(T),
    }
    expect(
      balanceCardStatus(facts({ own: incomplete as never, record: totalOnly }), T + 100).status
    ).toMatchObject({ kind: 'refreshing', reason: 'cached', shown: { split: { kind: 'loading' } } })
    // The read begun since the lock tells its total: that one is current.
    const told = { ...totalOnly, early: { requestId: 5, chainType, totalBalance: 93_000_000 } }
    expect(
      balanceCardStatus(facts({ own: incomplete as never, record: told }), T + 100).status
    ).toMatchObject({ kind: 'total', shown: { total: 93_000_000 } })
    // The background's kept answer at open: still a quiet start.
    expect(
      balanceCardStatus(facts({ kept, record: { reading: reading(T) } }), T + 100).status
    ).toMatchObject({ kind: 'ready', busy: true })
  })

  it("ignores another network's answer, kept answer and reads", () => {
    const other = ChainType.QBIT_TESTNET4
    const status = balanceCardStatus(
      facts({
        own: { ...complete, chainType: other },
        kept: { ...kept, balance: { ...kept.balance, chainType: other } },
        record: {
          reading: { ...reading(), chainType: other },
          early: { requestId: 5, chainType: other, totalBalance: 1 },
          outcome: { ...outcome('failed', 3, T), chainType: other },
          failed: {
            chainType: other,
            reads: [1, 2, 3].map(requestId => ({ requestId, startedAt: T + requestId * 20_000 })),
          },
        },
      }),
      T + 60_000
    ).status
    expect(status.kind).toBe('loading')
  })

  it('carries a hidden balance in every status', () => {
    for (const over of [{}, { own: complete }, { own: incomplete as never }, { kept }]) {
      expect(balanceCardStatus(facts({ ...over, hidden: true }), T).status.hidden).toBe(true)
    }
  })
})

describe('balanceCardMessage', () => {
  const shown = {
    total: 1,
    split: { kind: 'known' as const, available: 1, unavailable: 0 },
    limitExceeded: false,
    source: 'own' as const,
  }
  const progress = { read: 1, total: 2 }
  const totalOnly = { ...shown, split: { kind: 'loading' as const } }
  const overLimit = { ...shown, split: { kind: 'limit' as const }, limitExceeded: true }
  it.each<[BalanceCardStatus, ReturnType<typeof balanceCardMessage>]>([
    [{ kind: 'failed-empty', hidden: false, busy: true }, 'load-error'],
    [{ kind: 'failed', shown, totalCurrent: false, hidden: false, busy: true }, 'refresh-error'],
    [
      { kind: 'failed', shown: overLimit, totalCurrent: true, hidden: false, busy: false },
      'refresh-error',
    ],
    [
      { kind: 'failed', shown: totalOnly, totalCurrent: true, hidden: false, busy: true },
      'outputs-unread',
    ],
    [
      { kind: 'failed', shown: totalOnly, totalCurrent: false, hidden: false, busy: false },
      'outputs-unread',
    ],
    [
      { kind: 'refreshing', shown, reason: 'poll', progress, hidden: false, busy: true },
      'progress',
    ],
    [{ kind: 'refreshing', shown, reason: 'cached', hidden: false, busy: true }, 'updating'],
    [{ kind: 'total', shown, progress, hidden: false, busy: true }, 'progress'],
    [{ kind: 'total', shown, hidden: false, busy: true }, undefined],
    [{ kind: 'loading', progress, hidden: false, busy: true }, 'progress'],
    [{ kind: 'loading', hidden: false, busy: true }, undefined],
    [{ kind: 'ready', shown, hidden: false, busy: false }, undefined],
  ])('gives one message, by precedence: %o', (status, message) => {
    expect(balanceCardMessage(status)).toBe(message)
  })
})
