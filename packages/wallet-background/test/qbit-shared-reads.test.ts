import { describe, expect, it } from 'vitest'

import { QbitLatestAnswers, QbitReplaceableReads } from '../src/utils/qbit-shared-reads'

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
const later = (candidate: number, running: number) => candidate > running

describe('QbitReplaceableReads', () => {
  it('lets a caller with the same or an older version join the running read, never restart it', async () => {
    const reads = new QbitReplaceableReads<string, number>(later)
    const { started, read } = manualRead<string>()
    const first = reads.run(scope, 'account', 5, read)
    // The same statistics, and a lagging node's older ones.
    const same = reads.run(scope, 'account', 5, read)
    const older = reads.run(scope, 'account', 4, read)
    await Promise.resolve()

    expect(started).toHaveLength(1)
    expect(started[0]!.signal.aborted).toBe(false)
    started[0]!.resolve('answer')
    await expect(Promise.all([first, same, older])).resolves.toEqual(['answer', 'answer', 'answer'])
  })

  it('replaces the running read with a newer one, and hands its callers the newer answer', async () => {
    const reads = new QbitReplaceableReads<string, number>(later)
    const { started, read } = manualRead<string>()
    const first = reads.run(scope, 'account', 5, read)
    await Promise.resolve()
    const newer = reads.run(scope, 'account', 6, read)
    await Promise.resolve()

    expect(started).toHaveLength(2)
    expect(started[0]!.signal.aborted).toBe(true)
    // An answer arriving out of order after that joins the newer read.
    const outOfOrder = reads.run(scope, 'account', 5, read)
    await Promise.resolve()
    expect(started).toHaveLength(2)

    started[0]!.resolve('stale')
    started[1]!.resolve('fresh')
    await expect(Promise.all([first, newer, outOfOrder])).resolves.toEqual([
      'fresh',
      'fresh',
      'fresh',
    ])
  })

  it('stops a read once every caller has left, and starts afresh for the next', async () => {
    const reads = new QbitReplaceableReads<string, number>(later)
    const { started, read } = manualRead<string>()
    const left = [new AbortController(), new AbortController()]
    const callers = left.map(caller =>
      reads.run(scope, 'account', 5, read, caller.signal).catch(error => error)
    )
    await Promise.resolve()

    left[0]!.abort(new Error('left'))
    expect(started[0]!.signal.aborted).toBe(false)
    left[1]!.abort(new Error('left'))
    expect(started[0]!.signal.aborted).toBe(true)
    expect(await Promise.all(callers)).toEqual([new Error('left'), new Error('left')])

    const next = reads.run(scope, 'account', 5, read)
    await Promise.resolve()
    expect(started).toHaveLength(2)
    started[1]!.resolve('again')
    await expect(next).resolves.toBe('again')
  })

  it('keeps a read running for a caller without a signal', async () => {
    const reads = new QbitReplaceableReads<string, number>(later)
    const { started, read } = manualRead<string>()
    const waiting = reads.run(scope, 'account', 5, read)
    const caller = new AbortController()
    const leaving = reads.run(scope, 'account', 5, read, caller.signal).catch(error => error)
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
})
