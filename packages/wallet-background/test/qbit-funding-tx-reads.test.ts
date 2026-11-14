import { describe, expect, it } from 'vitest'

import {
  QBIT_CLASSIFY_MAX_READS_IN_FLIGHT,
  QBIT_FUNDING_FACTS_MAX_OUTPOINTS,
  QbitFundingTxReads,
  QbitReadLimiter,
  type QbitFundingFactsView,
} from '../src/utils/qbit-funding-tx-reads'

/** The facts `view` serves for `vouts` of `txid`, in that order. */
const served = (view: QbitFundingFactsView, txid: string, vouts: number[]) =>
  view
    .get(
      txid,
      vouts.map(vout => ({ vout }))
    )
    ?.map(({ facts }) => facts)

/** A read settled by hand, before or after it starts, which records whether it ran. */
function heldRead<T>(value: T) {
  let resolve: ((value: T) => void) | undefined
  let released = false
  let started = false
  return {
    read: () => {
      started = true
      return new Promise<T>(settle => {
        if (released) settle(value)
        else resolve = settle
      })
    },
    release: () => {
      released = true
      resolve?.(value)
    },
    get started() {
      return started
    },
  }
}

const flush = async (rounds = 5) => {
  for (let round = 0; round < rounds; round += 1) await Promise.resolve()
}

describe('QbitReadLimiter', () => {
  it('keeps 16 reads in flight by default and starts the rest in arrival order', async () => {
    const limiter = new QbitReadLimiter()
    expect(limiter.maxInFlight).toBe(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
    expect(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT).toBe(16)
    const reads = Array.from({ length: 20 }, (_, index) => heldRead(index))
    const results = reads.map(read => limiter.run(read.read))

    expect(reads.filter(read => read.started)).toHaveLength(16)
    expect(limiter.inFlight).toBe(16)
    expect(limiter.queued).toBe(4)

    // Each slot that frees goes to the read that has waited longest.
    reads[3]!.release()
    await flush()
    expect(reads.map(read => read.started)).toEqual([...Array(17).fill(true), false, false, false])
    reads[0]!.release()
    await flush()
    expect(reads[17]!.started).toBe(true)
    expect(reads[18]!.started).toBe(false)

    for (const read of reads) read.release()
    await expect(Promise.all(results)).resolves.toEqual(reads.map((_, index) => index))
    expect(limiter.inFlight).toBe(0)
    expect(limiter.queued).toBe(0)
  })

  it('puts a newcomer behind every read already waiting, never ahead of one', async () => {
    const limiter = new QbitReadLimiter(1)
    const first = heldRead('first')
    const second = heldRead('second')
    const third = heldRead('third')
    const order: string[] = []
    const track = (name: string) => (value: string) => {
      order.push(name)
      return value
    }
    const running = [
      limiter.run(first.read).then(track('first')),
      limiter.run(second.read).then(track('second')),
    ]
    first.release()
    // Asked for in the same turn as the slot frees: it still waits its turn.
    running.push(limiter.run(third.read).then(track('third')))
    await flush()
    expect(second.started).toBe(true)
    expect(third.started).toBe(false)
    second.release()
    await flush()
    third.release()
    await Promise.all(running)
    expect(order).toEqual(['first', 'second', 'third'])
  })

  it('ends a wait once its signal aborts, leaving no place in line behind', async () => {
    const limiter = new QbitReadLimiter(1)
    const holding = heldRead('held')
    const held = limiter.run(holding.read)
    const controller = new AbortController()
    const waiting = heldRead('never')
    const abandoned = limiter.run(waiting.read, controller.signal)
    expect(limiter.queued).toBe(1)

    const reason = new Error('the screen closed')
    controller.abort(reason)

    await expect(abandoned).rejects.toBe(reason)
    expect(limiter.queued).toBe(0)
    holding.release()
    await held
    expect(waiting.started).toBe(false)
    expect(limiter.inFlight).toBe(0)
    // Reusable: the next read runs at once.
    await expect(limiter.run(async () => 'next')).resolves.toBe('next')
  })

  it('refuses to start a read whose signal has aborted already', async () => {
    const limiter = new QbitReadLimiter()
    const controller = new AbortController()
    const reason = new Error('gone')
    controller.abort(reason)
    const read = heldRead('never')
    await expect(limiter.run(read.read, controller.signal)).rejects.toBe(reason)
    expect(read.started).toBe(false)
    expect(limiter.inFlight).toBe(0)
  })

  it('frees the slot of a read that fails, synchronously or not', async () => {
    const limiter = new QbitReadLimiter(1)
    const failure = new Error('read failed')
    await expect(
      limiter.run(() => {
        throw failure
      })
    ).rejects.toBe(failure)
    await expect(limiter.run(async () => Promise.reject(failure))).rejects.toBe(failure)
    await flush()
    expect(limiter.inFlight).toBe(0)
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok')
  })

  it('refuses a bound that is not a positive integer', () => {
    for (const bound of [0, -1, 1.5, Number.NaN]) {
      expect(() => new QbitReadLimiter(bound)).toThrow('maxInFlight')
    }
  })
})

describe('QbitFundingTxReads', () => {
  const script = `5220${'aa'.repeat(32)}`
  const txid = (index: number) => index.toString(16).padStart(64, '0')
  const facts = (value: number) => ({ coinbase: true, value, script })

  it('serves the facts kept for each output, all of a transaction or none', () => {
    const reads = new QbitFundingTxReads()
    const client = {}
    const view = reads.begin(client)
    view.keep(txid(1), 0, facts(1_000))
    view.keep(txid(1), 2, facts(3_000))

    expect(served(reads.begin(client), txid(1), [2, 0])).toEqual([facts(3_000), facts(1_000)])
    // One output never kept: nothing is served for the transaction.
    expect(served(reads.begin(client), txid(1), [0, 1])).toBeUndefined()
    expect(served(reads.begin(client), txid(2), [0])).toBeUndefined()
    expect(reads.size).toBe(2)
  })

  it('never serves facts kept through one client through another', () => {
    const reads = new QbitFundingTxReads()
    const mainnet = {}
    const testnet = {}
    reads.begin(mainnet).keep(txid(1), 0, facts(1_000))

    expect(served(reads.begin(testnet), txid(1), [0])).toBeUndefined()
    expect(served(reads.begin(mainnet), txid(1), [0])).toEqual([facts(1_000)])
  })

  it('replaces the facts of an output kept again, counting it once', () => {
    const reads = new QbitFundingTxReads()
    const client = {}
    reads.begin(client).keep(txid(1), 0, facts(1_000))
    reads.begin(client).keep(txid(1), 0, facts(2_000))
    expect(reads.size).toBe(1)
    expect(served(reads.begin(client), txid(1), [0])).toEqual([facts(2_000)])
  })

  it('keeps at most maxOutpoints outputs, the least recently used going first', () => {
    const reads = new QbitFundingTxReads({ maxOutpoints: 3 })
    const client = {}
    const view = reads.begin(client)
    view.keep(txid(1), 0, facts(1))
    view.keep(txid(2), 0, facts(2))
    view.keep(txid(3), 0, facts(3))
    // A use makes the first the most recently used.
    expect(served(view, txid(1), [0])).toEqual([facts(1)])
    view.keep(txid(4), 0, facts(4))

    expect(reads.size).toBe(3)
    expect(served(view, txid(2), [0])).toBeUndefined()
    for (const kept of [1, 3, 4]) expect(served(view, txid(kept), [0])).toEqual([facts(kept)])

    // A transaction goes whole: two outputs count two.
    view.keep(txid(5), 0, facts(5))
    view.keep(txid(5), 1, facts(6))
    expect(reads.size).toBeLessThanOrEqual(3)
    expect(served(view, txid(5), [0, 1])).toEqual([facts(5), facts(6)])
  })

  it('keeps an address at the 50,000-output listing limit whole by default', () => {
    expect(QBIT_FUNDING_FACTS_MAX_OUTPOINTS).toBeGreaterThanOrEqual(65_536)
    const reads = new QbitFundingTxReads()
    const client = {}
    const view = reads.begin(client)
    for (let index = 0; index < 50_000; index += 1) view.keep(txid(index), 0, facts(index))
    expect(reads.size).toBe(50_000)
    expect(served(view, txid(0), [0])).toEqual([facts(0)])
  })

  it('forgets everything on clear, and keeps nothing a classification begun before it reads after', () => {
    const reads = new QbitFundingTxReads()
    const client = {}
    const before = reads.begin(client)
    before.keep(txid(1), 0, facts(1))

    reads.clear()

    expect(reads.size).toBe(0)
    expect(served(reads.begin(client), txid(1), [0])).toBeUndefined()
    // A read that began before the clear and ends after it keeps nothing...
    before.keep(txid(2), 0, facts(2))
    expect(reads.size).toBe(0)
    // ...and is served nothing kept since by later reads.
    const after = reads.begin(client)
    after.keep(txid(3), 0, facts(3))
    expect(served(before, txid(3), [0])).toBeUndefined()
    expect(served(after, txid(3), [0])).toEqual([facts(3)])
  })

  it('says whether a kept fact is new: not one kept again, nor one it may not keep', () => {
    let usable = true
    const reads = new QbitFundingTxReads({ usable: () => usable })
    const client = {}
    const view = reads.begin(client)

    expect(view.keep(txid(1), 0, facts(1_000))).toBe(true)
    // Kept again, by this classification or another: a replacement, not news.
    expect(view.keep(txid(1), 0, facts(1_000))).toBe(false)
    expect(reads.begin(client).keep(txid(1), 0, facts(2_000))).toBe(false)
    // Another output of the same transaction, first or later in its list, is new once.
    expect(view.keep(txid(1), 1, facts(3_000))).toBe(true)
    expect(view.keep(txid(1), 2, facts(4_000))).toBe(true)
    expect(view.keep(txid(1), 1, facts(3_000))).toBe(false)
    expect(view.keep(txid(1), 0, facts(2_000))).toBe(false)
    expect(reads.size).toBe(3)

    // Nothing is kept while the facts may not be used, so nothing is new.
    usable = false
    expect(view.keep(txid(2), 0, facts(1))).toBe(false)
    usable = true
    expect(view.keep(txid(2), 0, facts(1))).toBe(true)

    // Nor by a classification that began before a clear.
    reads.clear()
    expect(view.keep(txid(3), 0, facts(1))).toBe(false)
    expect(reads.begin(client).keep(txid(3), 0, facts(1))).toBe(true)
  })

  it('serves and keeps nothing while it may not be used, and again once it may', () => {
    let usable = false
    const reads = new QbitFundingTxReads({ usable: () => usable })
    const client = {}
    const view = reads.begin(client)
    view.keep(txid(1), 0, facts(1))
    expect(reads.size).toBe(0)

    usable = true
    view.keep(txid(1), 0, facts(1))
    usable = false
    expect(served(view, txid(1), [0])).toBeUndefined()
    usable = true
    expect(served(view, txid(1), [0])).toEqual([facts(1)])
  })

  it('tells a classification which transactions another one is reading for their facts', () => {
    const reads = new QbitFundingTxReads()
    const client = {}
    const reading = reads.begin(client)
    const other = reads.begin(client)
    const done = reading.fetch(txid(1))

    expect(other.fetchingElsewhere(txid(1))).toBe(true)
    expect(other.fetchingElsewhere(txid(2))).toBe(false)
    expect(reads.begin({}).fetchingElsewhere(txid(1))).toBe(false)
    done()
    done()
    expect(other.fetchingElsewhere(txid(1))).toBe(false)

    // A read begun before a clear is nothing to wait for after it.
    reading.fetch(txid(3))
    reads.clear()
    expect(reads.begin(client).fetchingElsewhere(txid(3))).toBe(false)
  })

  it('shares one limiter per client', () => {
    const reads = new QbitFundingTxReads({ maxReadsInFlight: 4 })
    const client = {}
    expect(reads.limiter(client)).toBe(reads.limiter(client))
    expect(reads.limiter(client)).not.toBe(reads.limiter({}))
    expect(reads.limiter(client).maxInFlight).toBe(4)
    // A clear keeps the limiters: reads in flight still hold their slots.
    const limiter = reads.limiter(client)
    reads.clear()
    expect(reads.limiter(client)).toBe(limiter)
  })
})
