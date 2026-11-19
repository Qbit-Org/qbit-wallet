import { describe, expect, it } from 'vitest'
import { ChainType } from '@qbit/wallet-types'

import accountsReducer, {
  accountActions,
  balanceReadGivenUp,
  balanceReadJoinedByUser,
  balanceReadProgress,
  balanceReadsLocked,
  balanceReadStarted,
  initialState,
  setBalanceKept,
  type AccountsState,
} from '../../src/reducers/accounts'
import { balanceCardStatus } from '../../src/ui-hooks/useBalanceCardLogic'

const address = 'qbit-ordering-account'
const chainType = ChainType.QBIT_MAINNET
const complete = {
  availableBalance: 60_000_000,
  unavailableBalance: 31_000_000,
  totalBalance: 91_000_000,
  immatureBalance: 0,
  pendingBalance: 31_000_000,
  chainType,
}
const incomplete = {
  availableBalance: null,
  unavailableBalance: 92_000_000,
  totalBalance: 92_000_000,
  immatureBalance: null,
  pendingBalance: null,
  utxoReadIncomplete: true,
  chainType,
}
const kept = { balance: { ...complete, totalBalance: 90_000_000 }, readAt: 1_000 }

type Action = { type: string; payload?: unknown }
const run = (actions: Action[], from: AccountsState = initialState): AccountsState =>
  actions.reduce((state, action) => accountsReducer(state, action), from)

const started = (requestId: number, startedAt = requestId * 1_000, byUser = false) =>
  balanceReadStarted({ address, requestId, chainType, startedAt, byUser })
const total = (requestId: number, totalBalance = 92_000_000) =>
  balanceReadProgress({ address, requestId, chainType, totalBalance })
const progress = (requestId: number, read: number, of: number) =>
  balanceReadProgress({ address, requestId, chainType, read, total: of })
const answered = (requestId: number, balance: object = complete) =>
  accountActions.setBalanceV2({
    address,
    balance: balance as never,
    requestId,
    startedAt: requestId * 1_000,
  })
const failed = (requestId: number) =>
  accountActions.setBalanceError({ address, requestId, chainType, startedAt: requestId * 1_000 })
const keptAnswer = (entry = kept) => setBalanceKept({ address, ...entry } as never)

const record = (state: AccountsState) => state.balanceReadMap[address]
/** The card's status for the account at `now`, from the store alone. */
const statusOf = (state: AccountsState, now = 100_000) =>
  balanceCardStatus(
    {
      chainType,
      own: state.balanceV2Map[address],
      kept: state.balanceKeptMap[address],
      record: state.balanceReadMap[address],
      hidden: false,
    },
    now
  ).status

describe('balance read ordering (balanceReadMap, balanceKeptMap)', () => {
  describe('an early total and an answer', () => {
    it('drops the early total once its own read answers', () => {
      const state = run([started(1), total(1), answered(1)])
      expect(record(state)?.early).toBeUndefined()
      expect(statusOf(state).kind).toBe('ready')
    })

    it('keeps nothing of an early total that arrives after its own read answered', () => {
      const state = run([started(1), answered(1), total(1, 95_000_000)])
      expect(record(state)?.early).toBeUndefined()
      expect(state.balanceV2Map[address]?.totalBalance).toBe(91_000_000)
    })

    it("keeps a newer read's early total when an older read answers late", () => {
      const state = run([started(1), started(2), total(2), answered(1)])
      expect(record(state)?.early).toMatchObject({ requestId: 2, totalBalance: 92_000_000 })
      // A complete answer shown is never replaced by a total in flight: half
      // a second into the newer read, nothing visible has changed.
      expect(statusOf(state, 2_500)).toMatchObject({ kind: 'ready', shown: { total: 91_000_000 } })
    })

    it("keeps nothing of an older read's early total once a newer read answered", () => {
      const state = run([started(1), started(2), answered(2), total(1, 80_000_000)])
      expect(record(state)?.early).toBeUndefined()
      expect(statusOf(state)).toMatchObject({ kind: 'ready', shown: { total: 91_000_000 } })
    })

    it('never writes an early total into the answers other screens read', () => {
      const state = run([started(1), total(1)])
      expect(state.balanceV2Map).toEqual({})
      expect(state.balanceStatusMap).toEqual({})
      expect(statusOf(state)).toMatchObject({
        kind: 'total',
        shown: { total: 92_000_000, source: 'early' },
      })
    })

    it("shows a newer read's early total over an older incomplete answer", () => {
      const state = run([started(1), started(2), answered(1, incomplete), total(2, 93_000_000)])
      expect(statusOf(state)).toMatchObject({ kind: 'total', shown: { total: 93_000_000 } })
    })
  })

  describe('a progress report and an early total', () => {
    it('keeps both, in either order, for the same read', () => {
      for (const actions of [
        [started(1), total(1), progress(1, 10, 20)],
        [started(1), progress(1, 10, 20), total(1)],
      ]) {
        expect(record(run(actions))?.early).toEqual({
          requestId: 1,
          chainType,
          totalBalance: 92_000_000,
          read: 10,
          total: 20,
        })
      }
    })

    it('keeps nothing of an older read once a newer one began or reported', () => {
      expect(record(run([started(1), started(2), progress(1, 10, 20)]))?.early).toBeUndefined()
      expect(
        record(run([started(1), started(2), progress(2, 5, 20), progress(1, 10, 20)]))?.early
      ).toEqual({
        requestId: 2,
        chainType,
        read: 5,
        total: 20,
      })
    })

    it('keeps nothing of a read after a failure of the same or a newer read', () => {
      expect(record(run([started(1), failed(1), progress(1, 10, 20)]))?.early).toBeUndefined()
      expect(record(run([started(1), started(2), failed(2), total(1)]))?.early).toBeUndefined()
    })

    it('drops a count that is not a count', () => {
      expect(record(run([started(1), progress(1, 21, 20)]))?.early).toEqual({
        requestId: 1,
        chainType,
      })
      expect(record(run([started(1), progress(1, -1, 20)]))?.early).toEqual({
        requestId: 1,
        chainType,
      })
    })
  })

  describe('a kept answer and an answer of this page', () => {
    it("drops the kept answer once this page's own answer arrives", () => {
      const state = run([keptAnswer(), started(1), answered(1)])
      expect(state.balanceKeptMap[address]).toBeUndefined()
      expect(statusOf(state)).toMatchObject({
        kind: 'ready',
        shown: { total: 91_000_000, source: 'own' },
      })
    })

    it("never stores a kept answer over this page's own answer", () => {
      const state = run([started(1), answered(1), keptAnswer()])
      expect(state.balanceKeptMap[address]).toBeUndefined()
      expect(statusOf(state)).toMatchObject({ kind: 'ready', shown: { total: 91_000_000 } })
    })

    it("never stores a kept answer over this page's incomplete answer", () => {
      const state = run([started(1), answered(1, incomplete), keptAnswer()])
      expect(state.balanceKeptMap[address]).toBeUndefined()
      expect(statusOf(state)).toMatchObject({
        kind: 'total',
        shown: { total: 92_000_000, source: 'own' },
      })
    })

    it('keeps the kept answer through a rejected read, which brings no answer', () => {
      const state = run([keptAnswer(), started(1), failed(1)])
      expect(state.balanceKeptMap[address]).toEqual(kept)
      // One failure, well inside 30 s: still the kept answer, being refreshed.
      expect(statusOf(state, 1_500)).toMatchObject({ kind: 'refreshing', reason: 'cached' })
    })

    it('keeps the newer of two kept answers, in either order', () => {
      const newer = { balance: { ...kept.balance, totalBalance: 89_000_000 }, readAt: 2_000 }
      expect(run([keptAnswer(newer), keptAnswer()]).balanceKeptMap[address]).toEqual(newer)
      expect(run([keptAnswer(), keptAnswer(newer)]).balanceKeptMap[address]).toEqual(newer)
    })

    it('stores only a complete kept answer', () => {
      const state = run([keptAnswer({ balance: incomplete as never, readAt: 1_000 })])
      expect(state.balanceKeptMap[address]).toBeUndefined()
    })
  })

  describe('a kept answer and an early total', () => {
    it('keeps the kept answer shown, dimmed, while the early total agrees with it', () => {
      for (const actions of [
        [keptAnswer(), started(1), total(1, 90_000_000)],
        [started(1), total(1, 90_000_000), keptAnswer()],
      ]) {
        expect(statusOf(run(actions))).toMatchObject({
          kind: 'refreshing',
          reason: 'cached',
          shown: { total: 90_000_000, source: 'kept', split: { kind: 'known' } },
        })
      }
    })

    it('shows the early total, the split loading, once it differs from the kept one', () => {
      for (const actions of [
        [keptAnswer(), started(1), total(1)],
        [started(1), total(1), keptAnswer()],
      ]) {
        expect(statusOf(run(actions))).toMatchObject({
          kind: 'total',
          shown: { total: 92_000_000, source: 'early', split: { kind: 'loading' } },
        })
      }
    })
  })

  describe('the failed reads and the outcome', () => {
    const failedReads = (state: AccountsState) =>
      record(state)?.failed?.reads.map(read => [read.requestId, read.startedAt])

    it('counts the failed reads until a read begun after the newest of them settles without failing, complete or not (item 1)', () => {
      let state = run([started(1), answered(1), started(2), failed(2)])
      expect(failedReads(state)).toEqual([[2, 2_000]])
      // An answer that could not read every output, but did not fail, ends it.
      state = run([started(3), answered(3, incomplete)], state)
      expect(record(state)?.outcome).toEqual({
        requestId: 3,
        chainType,
        kind: 'partial',
        startedAt: 3_000,
      })
      expect(failedReads(state)).toBeUndefined()
      state = run([started(4), failed(4), started(5), failed(5)], state)
      expect(failedReads(state)).toEqual([
        [4, 4_000],
        [5, 5_000],
      ])
      // A newer read's early total and count end nothing: only how it settles.
      state = run([started(6), total(6), progress(6, 10, 20)], state)
      expect(failedReads(state)).toEqual([
        [4, 4_000],
        [5, 5_000],
      ])
      state = run([answered(6)], state)
      expect(failedReads(state)).toBeUndefined()
      expect(record(state)?.outcome).toEqual({
        requestId: 6,
        chainType,
        kind: 'complete',
        startedAt: 6_000,
      })
    })

    it('leaves the trouble on for an answer begun between two failed reads that arrives last (R3-7)', () => {
      const state = run([
        started(1),
        failed(1),
        started(2),
        started(3),
        failed(3),
        answered(2, incomplete),
      ])
      expect(failedReads(state)).toEqual([
        [1, 1_000],
        [3, 3_000],
      ])
    })

    it('ends the failure of a read given up on that answers after all, and no older answer ends a newer failure', () => {
      const givenUpThenAnswered = run([
        started(1),
        balanceReadGivenUp({ address, requestId: 1, chainType, startedAt: 1_000 }),
        answered(1, incomplete),
      ])
      expect(failedReads(givenUpThenAnswered)).toBeUndefined()
      const olderAnswer = run([
        started(1),
        started(2),
        started(3),
        failed(2),
        failed(3),
        answered(1),
      ])
      expect(failedReads(olderAnswer)).toEqual([
        [2, 2_000],
        [3, 3_000],
      ])
    })

    it('counts an answer whose read of the outputs failed, and a read given up on, as failures', () => {
      const state = run([
        started(1),
        answered(1, { ...incomplete, utxoReadFailed: true }),
        started(2),
        balanceReadGivenUp({ address, requestId: 2, chainType, startedAt: 2_000 }),
      ])
      expect(failedReads(state)).toEqual([
        [1, 1_000],
        [2, 2_000],
      ])
      // A read given up on is no outcome of the answers.
      expect(state.balanceStatusMap[address]).toEqual({
        requestId: 1,
        error: false,
        balanceRequestId: 1,
      })
    })

    it('never shows a failure under a complete answer newer than every failure, whatever the order (F4)', () => {
      const state = run([
        started(1),
        failed(1),
        started(2),
        answered(2, { ...incomplete, utxoReadFailed: true }),
        started(4),
        started(5),
        answered(5, incomplete),
        answered(4),
      ])
      expect(failedReads(state)).toBeUndefined()
      // The newer read was partial, with a total that moved: its total, the
      // split loading, never failed.
      expect(statusOf(state, 40_000)).toMatchObject({
        kind: 'total',
        shown: { total: 92_000_000, split: { kind: 'loading' } },
      })
      // With the same total, refreshing over read 4's split.
      const sameTotal = run([
        started(1),
        failed(1),
        started(4),
        started(5),
        answered(5, { ...incomplete, unavailableBalance: 91_000_000, totalBalance: 91_000_000 }),
        answered(4),
      ])
      expect(statusOf(sameTotal, 40_000)).toMatchObject({
        kind: 'refreshing',
        reason: 'retry',
        shown: { total: 91_000_000, split: { kind: 'known' } },
      })
    })

    it('does not count a failure that lands after a newer read settled', () => {
      const failedLate = run([started(1), started(2), answered(2, incomplete), failed(1)])
      expect(failedReads(failedLate)).toBeUndefined()
      const answeredFirst = run([started(1), started(2), answered(2), failed(1)])
      expect(record(answeredFirst)?.outcome).toMatchObject({ requestId: 2, kind: 'complete' })
      expect(failedReads(answeredFirst)).toBeUndefined()
    })

    it('changes no outcome for an older read that settles late', () => {
      const failedFirst = run([started(1), started(2), failed(2), answered(1)])
      expect(record(failedFirst)?.outcome).toMatchObject({ requestId: 2, kind: 'failed' })
      // The older complete answer is older than the failure: it ends nothing.
      expect(failedReads(failedFirst)).toEqual([[2, 2_000]])
    })

    it('starts the count over on another network', () => {
      const state = run([
        started(1),
        failed(1),
        accountActions.setBalanceError({
          address,
          requestId: 2,
          chainType: ChainType.QBIT_TESTNET4,
          startedAt: 2_000,
        }),
      ])
      expect(record(state)?.failed).toEqual({
        chainType: ChainType.QBIT_TESTNET4,
        reads: [{ requestId: 2, startedAt: 2_000 }],
      })
    })

    it('marks the read in flight as asked for by the user, and only that read', () => {
      expect(
        record(run([started(1), balanceReadJoinedByUser({ address, requestId: 1 })]))?.reading
          ?.byUser
      ).toBe(true)
      expect(
        record(run([started(2), balanceReadJoinedByUser({ address, requestId: 1 })]))?.reading
          ?.byUser
      ).toBe(false)
    })

    it('keeps the newest read begun as the read in progress, until a read at least as new settles', () => {
      expect(record(run([started(2), started(1)]))?.reading?.requestId).toBe(2)
      expect(record(run([started(1), started(2), answered(1)]))?.reading?.requestId).toBe(2)
      expect(record(run([started(1), started(2), answered(2)]))?.reading).toBeUndefined()
      // A read begun after a newer one settled is older than it: not in progress.
      expect(record(run([started(2), answered(2), started(1)]))?.reading).toBeUndefined()
    })
  })
})

describe('what stays shown through passing answers and failures', () => {
  const guardBusy = {
    ...incomplete,
    totalBalance: 91_000_000,
    unavailableBalance: 91_000_000,
    utxoReadIncomplete: undefined,
  }

  it('keeps an early total through the failure of its read, until a newer total or an answer replaces it (F8)', () => {
    let state = run([started(1), total(1), failed(1)])
    expect(record(state)?.early).toMatchObject({ requestId: 1, totalBalance: 92_000_000 })
    expect(statusOf(state, 1_500)).toMatchObject({ kind: 'total', shown: { total: 92_000_000 } })
    state = run([started(2), total(2, 93_000_000)], state)
    expect(statusOf(state, 2_500)).toMatchObject({ kind: 'total', shown: { total: 93_000_000 } })
    state = run([answered(2)], state)
    expect(record(state)?.early).toBeUndefined()
  })

  it('never counts a read backwards within one read', () => {
    const state = run([started(1), progress(1, 30, 40), progress(1, 5, 40)])
    expect(record(state)?.early).toMatchObject({ read: 30, total: 40 })
    // A count of another listing starts again.
    expect(record(run([progress(1, 5, 41)], state))?.early).toMatchObject({ read: 5, total: 41 })
  })

  it.each([
    // Stored over the split (as at the base): the card shows the last split it read.
    ['a guard-busy answer', guardBusy, 'last'],
    // Not stored over a known split (as at the base): the split stays the stored one.
    [
      'an incomplete answer',
      { ...incomplete, totalBalance: 91_000_000, unavailableBalance: 91_000_000 },
      'own',
    ],
  ])(
    'keeps the last split of its own shown, dimmed, under %s with the same total (F3)',
    (_case, passing, source) => {
      const state = run([started(1), answered(1), started(2), answered(2, passing)])
      expect(statusOf(state, 2_500)).toMatchObject({
        kind: 'refreshing',
        reason: 'retry',
        shown: { total: 91_000_000, source, split: { kind: 'known', available: 60_000_000 } },
      })
    }
  )

  it('shows the new total with the split loading when a passing answer brings another total', () => {
    const state = run([
      started(1),
      answered(1),
      started(2),
      answered(2, { ...guardBusy, totalBalance: 95_000_000 }),
    ])
    expect(statusOf(state, 2_500)).toMatchObject({
      kind: 'total',
      shown: { total: 95_000_000, split: { kind: 'loading' } },
    })
  })

  it('keeps the kept split shown, dimmed, under an incomplete answer of the same total, though the kept answer is dropped (F3)', () => {
    const sameTotal = { ...incomplete, totalBalance: 90_000_000, unavailableBalance: 90_000_000 }
    const state = run([keptAnswer(), started(1), answered(1, sameTotal)])
    expect(state.balanceKeptMap[address]).toBeUndefined()
    expect(statusOf(state, 1_500)).toMatchObject({
      kind: 'refreshing',
      reason: 'cached',
      shown: { total: 90_000_000, split: { kind: 'known' } },
    })
  })

  it('drops the kept answer for an answer of its network that lands late (F5)', () => {
    const state = run([keptAnswer(), started(1), started(2), failed(2), answered(1)])
    expect(state.balanceKeptMap[address]).toBeUndefined()
  })

  it('shows the kept answer, not the load error, when reads keep failing (V8)', () => {
    const state = run([
      keptAnswer(),
      balanceReadStarted({ address, requestId: 1, chainType, startedAt: 0 }),
      accountActions.setBalanceError({ address, requestId: 1, chainType, startedAt: 0 }),
      balanceReadStarted({ address, requestId: 2, chainType, startedAt: 10_000 }),
      accountActions.setBalanceError({ address, requestId: 2, chainType, startedAt: 10_000 }),
    ])
    expect(statusOf(state, 10_100)).toMatchObject({ kind: 'failed', shown: { source: 'kept' } })
  })
})

describe('answers from before a lock (B)', () => {
  it('marks what was read before the lock until a complete answer of a read begun after it', () => {
    let state = run([started(1), answered(1), balanceReadsLocked({ before: 1 })])
    expect(record(state)?.staleUpTo).toBe(1)
    // A late answer of a read begun before the lock changes nothing of that.
    state = run([started(2), answered(2, incomplete)], state)
    expect(record(state)?.staleUpTo).toBe(1)
    state = run([started(3), answered(3)], state)
    expect(record(state)?.staleUpTo).toBeUndefined()
    expect(statusOf(state, 3_000).kind).toBe('ready')
  })

  it('keeps a complete answer of the read begun just before the lock out of date (N11)', () => {
    // Read 2 began before the lock and answers in full after it.
    let state = run([
      started(1),
      answered(1),
      started(2),
      balanceReadsLocked({ before: 2 }),
      answered(2),
    ])
    expect(record(state)?.staleUpTo).toBe(2)
    expect(statusOf(state, 3_000)).toMatchObject({ kind: 'refreshing', reason: 'cached' })
    // The first read begun after it ends that.
    state = run([started(3), answered(3)], state)
    expect(record(state)?.staleUpTo).toBeUndefined()
  })

  it('marks every address the page has read', () => {
    const other = 'qbit-other-account'
    const state = run([
      started(1),
      accountActions.setBalanceV2({ address: other, balance: complete as never, requestId: 2 }),
      balanceReadsLocked({ before: 2 }),
    ])
    expect(state.balanceReadMap[address]?.staleUpTo).toBe(2)
    expect(state.balanceReadMap[other]?.staleUpTo).toBe(2)
  })
})
