import { describe, expect, it } from 'vitest'

import {
  QbitLatestAnswers,
  QbitReplaceableReads,
  type QbitReadVersionOrder,
} from '../src/utils/qbit-shared-reads'

/** A read the test answers by hand, recording the signal it was started with. */
function manualRead<T>() {
  const started: { signal: AbortSignal; resolve: (value: T) => void }[] = []
  const read = (signal: AbortSignal) =>
    new Promise<T>(resolve => {
      started.push({ signal, resolve })
    })
  return { started, read }
}

const scope = {}

/**
 * A version as the send screen's reads have one: how far the history had got
 * (`count`), and the rest of the statistics (`sums`), which can differ at the
 * same count, as after a replacement.
 */
type Version = { count: number; sums: string }
const at = (count: number, sums = 'a'): Version => ({ count, sums })
const order = (candidate: Version, running: Version): QbitReadVersionOrder => {
  if (candidate.count === running.count && candidate.sums === running.sums) return 'same'
  return candidate.count > running.count ? 'later' : 'other'
}

describe('QbitReplaceableReads', () => {
  it('lets a caller at the same version join the running read', async () => {
    const reads = new QbitReplaceableReads<string, Version>(order)
    const { started, read } = manualRead<string>()
    const first = reads.run(scope, 'account', at(5), read)
    const same = reads.run(scope, 'account', at(5), read)
    await Promise.resolve()

    expect(started).toHaveLength(1)
    started[0]!.resolve('answer')
    await expect(Promise.all([first, same])).resolves.toEqual(['answer', 'answer'])
  })

  it('replaces the running read with a later one, and hands its callers the later answer', async () => {
    const reads = new QbitReplaceableReads<string, Version>(order)
    const { started, read } = manualRead<string>()
    const first = reads.run(scope, 'account', at(5), read)
    await Promise.resolve()
    const later = reads.run(scope, 'account', at(6), read)
    await Promise.resolve()

    expect(started).toHaveLength(2)
    expect(started[0]!.signal.aborted).toBe(true)
    // An answer arriving out of order after that reads on its own, and
    // leaves the later read running.
    const outOfOrder = reads.run(scope, 'account', at(5), read)
    await Promise.resolve()
    expect(started).toHaveLength(3)
    expect(started[1]!.signal.aborted).toBe(false)

    started[0]!.resolve('stale')
    started[2]!.resolve('its own')
    started[1]!.resolve('fresh')
    await expect(Promise.all([first, later, outOfOrder])).resolves.toEqual([
      'fresh',
      'fresh',
      'its own',
    ])
  })

  it('never hands the running read to a caller that has seen another state, replaced or evicted', async () => {
    const reads = new QbitReplaceableReads<string, Version>(order)
    const { started, read } = manualRead<string>()
    const first = reads.run(scope, 'account', at(5, 'before'), read)
    // A replacement leaves the count and moves the sums; an eviction lowers the count.
    const replaced = reads.run(scope, 'account', at(5, 'replaced'), read)
    const evicted = reads.run(scope, 'account', at(4, 'evicted'), read)
    await Promise.resolve()

    expect(started).toHaveLength(3)
    expect(started.some(({ signal }) => signal.aborted)).toBe(false)
    // The reads complete out of order: the one started first answers last,
    // and its answer reaches only its own caller.
    started[2]!.resolve('after the eviction')
    started[1]!.resolve('after the replacement')
    started[0]!.resolve('before')
    await expect(Promise.all([first, replaced, evicted])).resolves.toEqual([
      'before',
      'after the replacement',
      'after the eviction',
    ])
  })

  it('cannot be kept restarting by answers that alternate between a current node and a lagging one', async () => {
    const reads = new QbitReplaceableReads<string, Version>(order)
    const { started, read } = manualRead<string>()
    // The lagging node answers first; the current node's answer replaces
    // that read once, and after that neither node's answers restart it.
    const callers = [reads.run(scope, 'account', at(5), read)]
    for (let round = 0; round < 3; round += 1) {
      callers.push(reads.run(scope, 'account', at(6), read))
      callers.push(reads.run(scope, 'account', at(5), read))
    }
    await Promise.resolve()

    expect(started.filter(({ signal }) => signal.aborted)).toHaveLength(1)
    expect(started[0]!.signal.aborted).toBe(true)
    // One read for the current node's callers and the first lagging one it
    // took over, and one beside it that the later lagging callers share.
    expect(started).toHaveLength(3)
    started.forEach(({ resolve }, index) => resolve(index === 1 ? 'current' : 'lagging'))
    await expect(Promise.all(callers)).resolves.toEqual([
      'current',
      'current',
      'lagging',
      'current',
      'lagging',
      'current',
      'lagging',
    ])
  })

  it('lets callers at the same other state share one read beside the running one', async () => {
    const reads = new QbitReplaceableReads<string, Version>(order)
    const { started, read } = manualRead<string>()
    const running = reads.run(scope, 'account', at(5, 'before'), read)
    const replaced = [
      reads.run(scope, 'account', at(5, 'replaced'), read),
      reads.run(scope, 'account', at(5, 'replaced'), read),
    ]
    await Promise.resolve()

    expect(started).toHaveLength(2)
    started[1]!.resolve('after the replacement')
    started[0]!.resolve('before')
    await expect(Promise.all([running, ...replaced])).resolves.toEqual([
      'before',
      'after the replacement',
      'after the replacement',
    ])

    // Once both have settled, the next caller at either state starts afresh.
    const next = reads.run(scope, 'account', at(5, 'replaced'), read)
    await Promise.resolve()
    expect(started).toHaveLength(3)
    started[2]!.resolve('again')
    await expect(next).resolves.toBe('again')
  })

  it('lets a later caller replace the latest read only, never those beside it', async () => {
    const reads = new QbitReplaceableReads<string, Version>(order)
    const { started, read } = manualRead<string>()
    const before = reads.run(scope, 'account', at(5, 'before'), read)
    // After an eviction: a read beside the latest, at a state that ranks
    // lower but may be newer. A node that has not seen the eviction ranks
    // later, and must not take this read's callers over.
    const evicted = reads.run(scope, 'account', at(4, 'evicted'), read)
    await Promise.resolve()
    const later = reads.run(scope, 'account', at(6), read)
    await Promise.resolve()

    expect(started).toHaveLength(3)
    expect(started[0]!.signal.aborted).toBe(true)
    expect(started[1]!.signal.aborted).toBe(false)
    started[0]!.resolve('stale')
    started[1]!.resolve('after the eviction')
    started[2]!.resolve('later')
    await expect(Promise.all([before, evicted, later])).resolves.toEqual([
      'later',
      'after the eviction',
      'later',
    ])
  })

  it('keeps the reads beside one that settled, and places later callers against the next latest', async () => {
    const reads = new QbitReplaceableReads<string, Version>(order)
    const { started, read } = manualRead<string>()
    const current = reads.run(scope, 'account', at(6), read)
    const lagging = reads.run(scope, 'account', at(5), read)
    await Promise.resolve()
    started[0]!.resolve('current')
    await expect(current).resolves.toBe('current')

    // The read beside it still runs: a caller at its state joins it. With no
    // latest running, one at another state becomes the latest, without
    // replacing it.
    const joined = reads.run(scope, 'account', at(5), read)
    const older = reads.run(scope, 'account', at(4), read)
    await Promise.resolve()
    expect(started).toHaveLength(3)
    // A later caller replaces that latest read, as any latest, and still not
    // the one beside it.
    const newer = reads.run(scope, 'account', at(6), read)
    await Promise.resolve()
    expect(started).toHaveLength(4)
    expect(started[2]!.signal.aborted).toBe(true)
    expect(started[1]!.signal.aborted).toBe(false)

    started[1]!.resolve('lagging')
    started[2]!.resolve('stale')
    started[3]!.resolve('current again')
    await expect(Promise.all([lagging, joined, older, newer])).resolves.toEqual([
      'lagging',
      'lagging',
      'current again',
      'current again',
    ])
  })

  it('keeps a read beside the running one while any of its callers waits', async () => {
    const reads = new QbitReplaceableReads<string, Version>(order)
    const { started, read } = manualRead<string>()
    const running = reads.run(scope, 'account', at(5, 'before'), read)
    const callers = [new AbortController(), new AbortController()]
    const beside = callers.map(caller =>
      reads.run(scope, 'account', at(5, 'replaced'), read, caller.signal).catch(error => error)
    )
    await Promise.resolve()
    expect(started).toHaveLength(2)

    callers[0]!.abort(new Error('left'))
    expect(started[1]!.signal.aborted).toBe(false)
    callers[1]!.abort(new Error('left'))
    expect(started[1]!.signal.aborted).toBe(true)
    expect(await Promise.all(beside)).toEqual([new Error('left'), new Error('left')])
    expect(started[0]!.signal.aborted).toBe(false)
    started[0]!.resolve('answer')
    await expect(running).resolves.toBe('answer')
  })

  it('stops a read of its own once its caller leaves, and keeps the running read', async () => {
    const reads = new QbitReplaceableReads<string, Version>(order)
    const { started, read } = manualRead<string>()
    const running = reads.run(scope, 'account', at(5, 'before'), read)
    const caller = new AbortController()
    const alone = reads
      .run(scope, 'account', at(5, 'replaced'), read, caller.signal)
      .catch(error => error)
    await Promise.resolve()

    caller.abort(new Error('left'))
    await expect(alone).resolves.toEqual(new Error('left'))
    expect(started[1]!.signal.aborted).toBe(true)
    expect(started[0]!.signal.aborted).toBe(false)
    // The running read is still the one a caller at its state joins, and the
    // stopped one is no longer joined.
    const joined = reads.run(scope, 'account', at(5, 'before'), read)
    const again = reads.run(scope, 'account', at(5, 'replaced'), read)
    await Promise.resolve()
    expect(started).toHaveLength(3)
    started[2]!.resolve('afresh')
    await expect(again).resolves.toBe('afresh')
    started[0]!.resolve('answer')
    await expect(Promise.all([running, joined])).resolves.toEqual(['answer', 'answer'])
  })

  it('stops a read once every caller has left, and starts afresh for the next', async () => {
    const reads = new QbitReplaceableReads<string, Version>(order)
    const { started, read } = manualRead<string>()
    const left = [new AbortController(), new AbortController()]
    const callers = left.map(caller =>
      reads.run(scope, 'account', at(5), read, caller.signal).catch(error => error)
    )
    await Promise.resolve()

    left[0]!.abort(new Error('left'))
    expect(started[0]!.signal.aborted).toBe(false)
    left[1]!.abort(new Error('left'))
    expect(started[0]!.signal.aborted).toBe(true)
    expect(await Promise.all(callers)).toEqual([new Error('left'), new Error('left')])

    const next = reads.run(scope, 'account', at(5), read)
    await Promise.resolve()
    expect(started).toHaveLength(2)
    started[1]!.resolve('again')
    await expect(next).resolves.toBe('again')
  })

  it('keeps a read running for a caller without a signal', async () => {
    const reads = new QbitReplaceableReads<string, Version>(order)
    const { started, read } = manualRead<string>()
    const waiting = reads.run(scope, 'account', at(5), read)
    const caller = new AbortController()
    const leaving = reads.run(scope, 'account', at(5), read, caller.signal).catch(error => error)
    await Promise.resolve()

    caller.abort(new Error('left'))
    await expect(leaving).resolves.toEqual(new Error('left'))
    expect(started[0]!.signal.aborted).toBe(false)
    started[0]!.resolve('answer')
    await expect(waiting).resolves.toBe('answer')
  })
})

describe('QbitLatestAnswers', () => {
  it('keeps the latest answer, for its scope and slot only', () => {
    const answers = new QbitLatestAnswers<string>()
    const client = {}
    expect(answers.latest(client, 'qb1a')).toBeUndefined()

    answers.keep(client, 'qb1a', answers.start(), 'outputs')

    expect(answers.latest(client, 'qb1a')).toBe('outputs')
    expect(answers.latest(client, 'qb1b')).toBeUndefined()
    expect(answers.latest({}, 'qb1a')).toBeUndefined()
  })

  it('lets a read that started later replace one that started earlier, never the reverse', () => {
    const answers = new QbitLatestAnswers<string>()
    const client = {}
    const firstRead = answers.start()
    const secondRead = answers.start()

    answers.keep(client, 'qb1a', secondRead, 'later')
    // The earlier read finishes last: it does not replace the later one.
    answers.keep(client, 'qb1a', firstRead, 'earlier')
    expect(answers.latest(client, 'qb1a')).toBe('later')

    // A read started after both replaces them, whatever it found: after an
    // eviction it may find less history than the one it replaces.
    answers.keep(client, 'qb1a', answers.start(), 'after an eviction')
    expect(answers.latest(client, 'qb1a')).toBe('after an eviction')
  })

  it('forgets every answer on clear, and keeps nothing from a read that started before it', () => {
    const answers = new QbitLatestAnswers<string>()
    const client = {}
    answers.keep(client, 'qb1a', answers.start(), 'kept')
    const running = answers.start()

    answers.clear()
    expect(answers.latest(client, 'qb1a')).toBeUndefined()

    answers.keep(client, 'qb1a', running, 'from before the clear')
    expect(answers.latest(client, 'qb1a')).toBeUndefined()
    answers.keep(client, 'qb1a', answers.start(), 'after')
    expect(answers.latest(client, 'qb1a')).toBe('after')
  })

  it('keeps the slots most recently used, up to its bound', () => {
    const answers = new QbitLatestAnswers<string>(2)
    const client = {}
    answers.keep(client, 'qb1a', answers.start(), 'a')
    answers.keep(client, 'qb1b', answers.start(), 'b')
    // Reading a slot counts as using it.
    expect(answers.latest(client, 'qb1a')).toBe('a')

    answers.keep(client, 'qb1c', answers.start(), 'c')

    expect(answers.latest(client, 'qb1b')).toBeUndefined()
    expect(answers.latest(client, 'qb1a')).toBe('a')
    expect(answers.latest(client, 'qb1c')).toBe('c')
  })
})
