import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QbitBalanceReadProgress, QbitBalanceSummary } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import {
  QBIT_BALANCE_PROGRESS_INTERVAL_MS,
  QbitBalanceProgressPublisher,
  QbitKeptBalances,
  isCompleteQbitBalance,
} from '../src/utils/qbit-balance-answers'

const chainType = ChainType.QBIT_MAINNET
const answer = (
  totalBalance: number,
  more: Partial<QbitBalanceSummary> = {}
): QbitBalanceSummary => ({
  availableBalance: totalBalance,
  unavailableBalance: 0,
  totalBalance,
  immatureBalance: 0,
  pendingBalance: 0,
  chainType,
  ...more,
})

describe('isCompleteQbitBalance', () => {
  it.each<[string, Partial<QbitBalanceSummary>, boolean]>([
    ['a split', {}, true],
    [
      'the explorer limit, the split unknown',
      { availableBalance: null, utxoLimitExceeded: true },
      true,
    ],
    ['outputs not all read', { availableBalance: null, utxoReadIncomplete: true }, false],
    [
      'a failed read of the outputs',
      { availableBalance: null, utxoReadIncomplete: true, utxoReadFailed: true },
      false,
    ],
    ['the send guard busy', { availableBalance: null }, false],
  ])('is %s complete: %s', (_case, more, complete) => {
    expect(isCompleteQbitBalance(answer(1, more))).toBe(complete)
  })
})

/** Whether `kept` holds an answer in memory for `address` on `chain`, served or not. */
const holds = (kept: QbitKeptBalances, chain: string, address: string): boolean =>
  (kept as unknown as { networks: Map<string, Map<string, unknown>> }).networks
    .get(chain)
    ?.has(address) === true

describe('QbitKeptBalances', () => {
  it('keeps the answer of the read begun last, whichever ends last', () => {
    const kept = new QbitKeptBalances({ now: () => 0 })
    const older = kept.begin()
    const newer = kept.begin()
    kept.keep(newer, chainType, 'a', answer(2))
    kept.keep(older, chainType, 'a', answer(1))
    expect(kept.peek(chainType, 'a')?.balance.totalBalance).toBe(2)
  })

  it('dates an answer by when its read began', () => {
    let now = 1_000
    const kept = new QbitKeptBalances({ now: () => now })
    const place = kept.begin()
    now = 5_000
    kept.keep(place, chainType, 'a', answer(1))
    expect(kept.peek(chainType, 'a')?.readAt).toBe(1_000)
  })

  it('keeps the addresses most recently kept or served, a few per network', () => {
    const kept = new QbitKeptBalances({ maxPerNetwork: 2 })
    kept.keep(kept.begin(), chainType, 'a', answer(1))
    kept.keep(kept.begin(), chainType, 'b', answer(2))
    // Served, so 'b' is the least recently used.
    kept.peek(chainType, 'a')
    kept.keep(kept.begin(), chainType, 'c', answer(3))
    kept.keep(
      kept.begin(),
      ChainType.QBIT_TESTNET4,
      'z',
      answer(9, { chainType: ChainType.QBIT_TESTNET4 })
    )
    expect(['a', 'b', 'c'].map(address => holds(kept, chainType, address))).toEqual([
      true,
      false,
      true,
    ])
    expect(holds(kept, ChainType.QBIT_TESTNET4, 'z')).toBe(true)
  })

  it('keeps nothing for another network, and nothing incomplete', () => {
    const kept = new QbitKeptBalances()
    kept.keep(kept.begin(), chainType, 'a', answer(1, { chainType: ChainType.QBIT_TESTNET4 }))
    kept.keep(
      kept.begin(),
      chainType,
      'b',
      answer(1, { availableBalance: null, utxoReadIncomplete: true })
    )
    expect(holds(kept, chainType, 'a')).toBe(false)
    expect(holds(kept, chainType, 'b')).toBe(false)
  })

  it('forgets at both ends of a submission, keeps nothing of a read begun before its end, and lets such a read go on telling its page (item 8)', () => {
    const kept = new QbitKeptBalances()
    kept.keep(kept.begin(), chainType, 'a', answer(1))
    const before = kept.begin()
    const settled = kept.submission()
    expect(holds(kept, chainType, 'a')).toBe(false)
    // A read during the submission keeps its answer for now ...
    const during = kept.begin()
    kept.keep(during, chainType, 'b', answer(2))
    expect(holds(kept, chainType, 'b')).toBe(true)
    // ... which goes as it settles; a read begun before then keeps nothing.
    settled()
    expect(holds(kept, chainType, 'b')).toBe(false)
    kept.keep(during, chainType, 'c', answer(3))
    kept.keep(before, chainType, 'c', answer(3))
    expect(holds(kept, chainType, 'c')).toBe(false)
    // Neither ends what those reads may tell their pages; a clear does.
    expect(kept.current(before)).toBe(true)
    expect(kept.current(during)).toBe(true)
    kept.clear()
    expect(kept.current(during)).toBe(false)
    // A read begun after it all keeps its answer.
    kept.keep(kept.begin(), chainType, 'd', answer(4))
    expect(holds(kept, chainType, 'd')).toBe(true)
  })

  it('keeps and serves nothing while unusable, and nothing of a read begun before a clear', () => {
    let usable = true
    const kept = new QbitKeptBalances({ usable: () => usable })
    kept.keep(kept.begin(), chainType, 'a', answer(1))
    usable = false
    expect(kept.peek(chainType, 'a')).toBeUndefined()
    kept.keep(kept.begin(), chainType, 'b', answer(2))
    expect(holds(kept, chainType, 'b')).toBe(false)
    usable = true
    const before = kept.begin()
    kept.clear()
    kept.keep(before, chainType, 'c', answer(3))
    expect(holds(kept, chainType, 'a')).toBe(false)
    expect(holds(kept, chainType, 'c')).toBe(false)
    expect(kept.current(before)).toBe(false)
    expect(kept.current(kept.begin())).toBe(true)
  })
})

describe('QbitBalanceProgressPublisher', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function publisher(mayPublish = () => true) {
    const sent: QbitBalanceReadProgress[] = []
    const progress = new QbitBalanceProgressPublisher({
      progressId: 'p',
      address: 'a',
      chainType,
      mayPublish,
      send: event => sent.push(event),
    })
    return { sent, progress }
  }

  it(`sends the total at once, then the count every ${QBIT_BALANCE_PROGRESS_INTERVAL_MS} ms only when it moved, and nothing once closed`, () => {
    vi.useFakeTimers()
    const { sent, progress } = publisher()
    let count: { read: number; total: number } | undefined
    progress.observer.totalRead(5_000, () => count)
    expect(sent).toEqual([
      { progressId: 'p', kind: 'total', address: 'a', chainType, totalBalance: 5_000 },
    ])

    vi.advanceTimersByTime(QBIT_BALANCE_PROGRESS_INTERVAL_MS)
    // Not listed yet: nothing to count.
    expect(sent).toHaveLength(1)
    count = { read: 3, total: 10 }
    vi.advanceTimersByTime(QBIT_BALANCE_PROGRESS_INTERVAL_MS - 1)
    expect(sent).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sent.at(-1)).toMatchObject({ kind: 'outputs', read: 3, total: 10 })
    vi.advanceTimersByTime(QBIT_BALANCE_PROGRESS_INTERVAL_MS * 4)
    expect(sent).toHaveLength(2)
    count = { read: 10, total: 10 }
    vi.advanceTimersByTime(QBIT_BALANCE_PROGRESS_INTERVAL_MS)
    expect(sent).toHaveLength(3)

    progress.close()
    expect(vi.getTimerCount()).toBe(0)
    count = { read: 11, total: 11 }
    progress.observer.totalRead(1, () => count)
    vi.advanceTimersByTime(QBIT_BALANCE_PROGRESS_INTERVAL_MS * 4)
    expect(sent).toHaveLength(3)
  })

  it('never sends a count lower than the last for the same listing, as when the outputs are classified again', () => {
    vi.useFakeTimers()
    const { sent, progress } = publisher()
    let count = { read: 30, total: 40 }
    progress.observer.totalRead(5_000, () => count)
    vi.advanceTimersByTime(QBIT_BALANCE_PROGRESS_INTERVAL_MS)
    count = { read: 4, total: 40 }
    vi.advanceTimersByTime(QBIT_BALANCE_PROGRESS_INTERVAL_MS * 2)
    count = { read: 35, total: 40 }
    vi.advanceTimersByTime(QBIT_BALANCE_PROGRESS_INTERVAL_MS)
    // Another listing, of another size, counts from its own start.
    count = { read: 2, total: 41 }
    vi.advanceTimersByTime(QBIT_BALANCE_PROGRESS_INTERVAL_MS)
    expect(sent.slice(1).map(event => ('read' in event ? [event.read, event.total] : []))).toEqual([
      [30, 40],
      [35, 40],
      [2, 41],
    ])
    progress.close()
  })

  it('sends nothing while it may not, and asks before every event', () => {
    vi.useFakeTimers()
    let may = false
    const { sent, progress } = publisher(() => may)
    progress.observer.totalRead(5_000, () => ({ read: 1, total: 2 }))
    vi.advanceTimersByTime(QBIT_BALANCE_PROGRESS_INTERVAL_MS)
    expect(sent).toEqual([])
    may = true
    // The count did not move since it was last looked at: still nothing new to send.
    vi.advanceTimersByTime(QBIT_BALANCE_PROGRESS_INTERVAL_MS)
    expect(sent).toEqual([])
    progress.close()
  })

  it('sends no total that is not an amount, and starts no timer for it', () => {
    vi.useFakeTimers()
    const { sent, progress } = publisher()
    progress.observer.totalRead(Number.NaN, () => ({ read: 1, total: 2 }))
    expect(sent).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    progress.close()
  })

  it('changes nothing in the read when its page cannot be told', () => {
    vi.useFakeTimers()
    const progress = new QbitBalanceProgressPublisher({
      progressId: 'p',
      address: 'a',
      chainType,
      mayPublish: () => true,
      send: () => {
        throw new Error('port gone')
      },
    })
    expect(() => progress.observer.totalRead(1, () => ({ read: 1, total: 1 }))).not.toThrow()
    expect(() => vi.advanceTimersByTime(QBIT_BALANCE_PROGRESS_INTERVAL_MS)).not.toThrow()
    progress.close()
    expect(vi.getTimerCount()).toBe(0)
  })
})
