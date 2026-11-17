import { describe, expect, it, vi } from 'vitest'

import {
  QbitFundingTxReads,
  type QbitFundingFactsView,
  type QbitFundingOutputFacts,
} from '../src/utils/qbit-funding-tx-reads'
import { ACCOUNT_SCRIPT, OTHER_SCRIPT } from './qbit-classify-reads-fake'

/**
 * What the facts cache keeps, served by a model with nothing to it but its
 * rules: each transaction's outputs by number, the transactions least
 * recently used first, the latest facts of an output replacing any before,
 * and past `max` outputs the least recently used transactions pushed out,
 * whole, until it is within it again.
 */
class ReferenceFacts {
  private txs = new Map<string, Map<number, QbitFundingOutputFacts>>()
  outpoints = 0

  constructor(private readonly max: number) {}

  keep(txid: string, vout: number, facts: QbitFundingOutputFacts): boolean {
    const outputs = this.txs.get(txid) ?? new Map<number, QbitFundingOutputFacts>()
    this.txs.delete(txid)
    const replaced = outputs.has(vout)
    outputs.set(vout, { ...facts })
    this.txs.set(txid, outputs)
    if (!replaced) this.outpoints += 1
    for (const [oldest, kept] of this.txs) {
      if (this.outpoints <= this.max) break
      this.txs.delete(oldest)
      this.outpoints -= kept.size
    }
    return !replaced
  }

  get(txid: string, outputs: readonly { vout: number }[]) {
    const kept = this.txs.get(txid)
    if (!kept) return undefined
    const found: { output: { vout: number }; facts: QbitFundingOutputFacts }[] = []
    for (const output of outputs) {
      const facts = kept.get(output.vout)
      if (!facts) return undefined
      found.push({ output, facts })
    }
    this.touch(txid)
    return found
  }

  has(txid: string, vout: number): boolean {
    return this.txs.get(txid)?.has(vout) ?? false
  }

  touch(txid: string): void {
    const kept = this.txs.get(txid)
    if (!kept) return
    this.txs.delete(txid)
    this.txs.set(txid, kept)
  }

  forget(txid: string): void {
    const kept = this.txs.get(txid)
    if (!kept) return
    this.txs.delete(txid)
    this.outpoints -= kept.size
  }
}

/** A seeded generator of numbers in [0, 1), the same sequence every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

const txidOf = (index: number): string => index.toString(16).padStart(64, '0')

/** The transactions the model keeps, least recently used first, by key: its own state. */
const modelOf = (reference: ReferenceFacts): Map<string, Map<number, QbitFundingOutputFacts>> =>
  (reference as unknown as { txs: Map<string, Map<number, QbitFundingOutputFacts>> }).txs

/** A node of a kept transaction's list, as the cache holds it. */
interface FactsNodeState {
  readonly vout: number
  readonly value: number
  readonly script: string
  readonly coinbase: boolean
  readonly next: FactsNodeState | undefined
}

/** What the cache holds behind its views: its private fields. */
interface FactsState {
  readonly facts: Map<
    string,
    FactsNodeState & { readonly older: string | undefined; readonly newer: string | undefined }
  >
  readonly indexes: Map<string, Map<number, FactsNodeState>>
  readonly oldest: string | undefined
  readonly newest: string | undefined
}

/**
 * The cache's order of use, oldest first, from `oldest` through each first
 * node's `newer`, and where it goes wrong: it must run through every
 * transaction kept, each once, each naming the one before it, the last being
 * `newest`, and none naming one no longer kept.
 */
function orderOfUse(reads: QbitFundingTxReads): { order: string[]; problems: string[] } {
  const state = reads as unknown as FactsState
  const order: string[] = []
  const problems: string[] = []
  let older: string | undefined
  for (let key = state.oldest; key !== undefined; ) {
    const head = state.facts.get(key)
    if (!head || order.length === state.facts.size) {
      const what = head ? 'again' : 'not kept'
      problems.push(`the order of use goes on after ${order.length} to ${key}, ${what}`)
      break
    }
    if (head.older !== older) {
      problems.push(`${key} names ${head.older} as used before it, not ${older}`)
    }
    order.push(key)
    older = key
    key = head.newer
  }
  if (state.newest !== older) problems.push(`the newest is ${state.newest}, not ${older}`)
  if (order.length !== state.facts.size) {
    problems.push(`the order of use runs through ${order.length} of ${state.facts.size} kept`)
  }
  return { order, problems }
}

/**
 * Whether the order of use begins and ends at transactions kept, and is empty
 * only when none is: a few lookups, so checked after every keep of a long
 * run, where a transaction dropped but left in the order would otherwise be
 * found only by a later push-out.
 */
function endsKept(reads: QbitFundingTxReads): boolean {
  const { facts, oldest, newest } = reads as unknown as FactsState
  if (facts.size === 0) return oldest === undefined && newest === undefined
  return oldest !== undefined && newest !== undefined && facts.has(oldest) && facts.has(newest)
}

/**
 * Where the cache's order of use, its map of facts and the index of each long
 * list disagree with each other or with `reference`, kept by the same keys:
 * the order of use must be sound (`orderOfUse`) and the model's, oldest
 * first; each transaction must hold the outputs and facts the model holds,
 * the count their sum; and exactly each list of more than 16 outputs must
 * have an index, of its own nodes.
 */
function disagreements(reads: QbitFundingTxReads, reference: ReferenceFacts): string[] {
  const state = reads as unknown as FactsState
  const model = modelOf(reference)
  const { order, problems: found } = orderOfUse(reads)
  const modelOrder = [...model.keys()]
  if (order.join(' ') !== modelOrder.join(' ')) {
    found.push(`the order of use is [${order.join(' ')}], not [${modelOrder.join(' ')}]`)
  }
  if (state.facts.size !== model.size) found.push(`${state.facts.size} kept, not ${model.size}`)
  let outputs = 0
  let indexed = 0
  for (const [key, head] of state.facts) {
    const nodes: FactsNodeState[] = []
    for (let node: FactsNodeState | undefined = head; node; node = node.next) {
      if (nodes.length > reads.maxOutpoints) break
      nodes.push(node)
    }
    outputs += nodes.length
    const kept = model.get(key) ?? new Map<number, QbitFundingOutputFacts>()
    if (new Set(nodes.map(node => node.vout)).size !== kept.size || nodes.length !== kept.size) {
      found.push(`${key} holds outputs ${nodes.map(node => node.vout)}, not ${[...kept.keys()]}`)
    }
    for (const { vout, value, script, coinbase } of nodes) {
      const facts = kept.get(vout)
      if (
        !facts ||
        facts.value !== value ||
        facts.script !== script ||
        facts.coinbase !== coinbase
      ) {
        found.push(`${key}:${vout} holds other facts than the model`)
      }
    }
    const index = state.indexes.get(key)
    if (nodes.length > 16) {
      indexed += 1
      if (
        !index ||
        index.size !== nodes.length ||
        nodes.some(node => index.get(node.vout) !== node)
      ) {
        found.push(`${key}, of ${nodes.length} outputs, has no index of its nodes`)
      }
    } else if (index) {
      found.push(`${key}, of ${nodes.length} outputs, has an index`)
    }
  }
  if (state.indexes.size !== indexed) found.push(`${state.indexes.size} indexes, not ${indexed}`)
  if (outputs !== reads.size) found.push(`${outputs} outputs held, ${reads.size} counted`)
  return found
}

describe('the funding facts cache, its outputs indexed (#209)', () => {
  it.each([
    // Pushing out often, a few transactions of hundreds of outputs among many of one.
    [1, 400],
    [2, 400],
    [3, 60],
    // Large enough that nothing is pushed out.
    [4, 100_000],
  ])(
    'serves, keeps and pushes out exactly as the rules say, over random uses (seed %i, at most %i outputs)',
    (seed, max) => {
      const random = seeded(seed)
      const reads = new QbitFundingTxReads({ maxOutpoints: max })
      let view: QbitFundingFactsView = reads.begin({})
      let reference = new ReferenceFacts(max)
      // Transactions 0 to 7 pay the address up to 300 times, the rest up to 3.
      const outputsOf = (tx: number): number => (tx < 8 ? 300 : 3)
      const pick = (below: number): number => Math.floor(random() * below)
      const factsOf = (): QbitFundingOutputFacts => ({
        coinbase: random() < 0.1,
        value: 1 + pick(1_000_000),
        script: random() < 0.5 ? ACCOUNT_SCRIPT : OTHER_SCRIPT,
      })

      for (let step = 0; step < 30_000; step += 1) {
        const tx = pick(40)
        const txid = txidOf(tx)
        const roll = random()
        let label: string
        if (roll < 0.5) {
          // A run of outputs kept, as a classification keeps a group's.
          const from = pick(outputsOf(tx))
          const count = 1 + pick(tx < 8 ? 120 : 2)
          for (let vout = from; vout < Math.min(outputsOf(tx), from + count); vout += 1) {
            const facts = factsOf()
            expect(view.keep(txid, vout, facts), `keep ${tx}:${vout}`).toBe(
              reference.keep(txid, vout, facts)
            )
            // Before the run's next keep can push out again; on every keep,
            // so asserted only when it fails.
            if (!endsKept(reads)) expect.unreachable(`order of use after keep ${tx}:${vout}`)
          }
          label = 'keep'
        } else if (roll < 0.75) {
          const from = pick(outputsOf(tx))
          const outputs = Array.from({ length: 1 + pick(tx < 8 ? 300 : 3) }, (_, index) => ({
            vout: (from + index) % outputsOf(tx),
          })).filter((output, index, all) => all.findIndex(o => o.vout === output.vout) === index)
          expect(view.get(txid, outputs), `get ${tx}`).toEqual(reference.get(txid, outputs))
          label = 'get'
        } else if (roll < 0.88) {
          const vout = pick(outputsOf(tx))
          expect(view.has(txid, vout), `has ${tx}:${vout}`).toBe(reference.has(txid, vout))
          label = 'has'
        } else if (roll < 0.95) {
          view.touch(txid)
          reference.touch(txid)
          label = 'touch'
        } else if (roll < 0.999) {
          view.forget(txid)
          reference.forget(txid)
          label = 'forget'
        } else {
          reads.clear()
          view = reads.begin({})
          reference = new ReferenceFacts(max)
          label = 'clear'
        }
        expect(reads.size, `size after ${label} at step ${step}`).toBe(reference.outpoints)
        if (!endsKept(reads)) expect.unreachable(`order of use after ${label} at step ${step}`)
      }
    },
    // A second or two alone; a loaded host has stretched such tests threefold and more.
    60_000
  )

  it('serves, keeps and finds the outputs of one transaction paying the address 60,000 times in time that grows with their number', () => {
    // Through a list alone, as before, each of these took time growing with
    // the square of the outputs: all of this took 21 s of processor time.
    // Indexed, it takes about 0.17 s. The bound is on this process's own
    // processor time, which a busy host barely stretches, and is more than
    // ten times either way from both.
    const reads = new QbitFundingTxReads({ maxOutpoints: 100_000 })
    const view = reads.begin({})
    const txid = txidOf(1)
    const outputs = Array.from({ length: 60_000 }, (_, vout) => ({ vout }))
    const facts = { coinbase: false, value: 10_000, script: ACCOUNT_SCRIPT }
    const started = process.cpuUsage()

    for (const { vout } of outputs) view.keep(txid, vout, facts)
    const served = view.get(txid, outputs)
    let found = 0
    for (const { vout } of outputs) if (view.has(txid, vout)) found += 1
    for (const { vout } of outputs) view.keep(txid, vout, { ...facts, value: 20_000 })

    const used = process.cpuUsage(started)
    expect(served).toHaveLength(60_000)
    expect(found).toBe(60_000)
    expect(view.get(txid, [{ vout: 59_999 }])?.[0]?.facts.value).toBe(20_000)
    expect(reads.size).toBe(60_000)
    expect((used.user + used.system) / 1_000).toBeLessThan(2_000)
  })
})

describe('what the funding facts cache spends keeping facts (#209)', () => {
  it('walks none of its transactions to keep facts, within its bound or past it', () => {
    // A walk of the map begins at its first place and passes every place
    // moved and deleted entries have left there since the map was last
    // rebuilt, so walking it to keep facts would cost each keep time growing
    // with the uses and drops before it.
    const reads = new QbitFundingTxReads({ maxOutpoints: 2_000 })
    const view = reads.begin({})
    const facts = { coinbase: false, value: 10_000, script: ACCOUNT_SCRIPT }
    for (let tx = 0; tx < 1_000; tx += 1) view.keep(txidOf(tx), 0, facts)
    // Every way to walk a map, counted while it keeps and checked once the
    // spies are gone, so that no check's own walk is counted.
    const walks = [
      vi.spyOn(Map.prototype, Symbol.iterator),
      vi.spyOn(Map.prototype, 'entries'),
      vi.spyOn(Map.prototype, 'keys'),
      vi.spyOn(Map.prototype, 'values'),
      vi.spyOn(Map.prototype, 'forEach'),
    ]
    const walked = (): number => walks.reduce((sum, walk) => sum + walk.mock.calls.length, 0)
    let withinBound = -1
    let pastBound = -1
    try {
      // Used, kept again and kept anew, all within its bound.
      for (let tx = 0; tx < 1_000; tx += 1) view.touch(txidOf(tx))
      for (let tx = 0; tx < 1_000; tx += 1) view.keep(txidOf(tx), 0, facts)
      for (let tx = 1_000; tx < 2_000; tx += 1) view.keep(txidOf(tx), 0, facts)
      withinBound = walked()
      // One more than it holds: the oldest goes, found at the old end of the
      // order of use.
      view.keep(txidOf(2_000), 0, facts)
      pastBound = walked() - withinBound
    } finally {
      for (const walk of walks) walk.mockRestore()
    }
    expect(withinBound).toBe(0)
    expect(pastBound).toBe(0)
    expect(reads.size).toBe(2_000)
    expect(view.has(txidOf(0), 0)).toBe(false)
    expect(view.has(txidOf(2_000), 0)).toBe(true)
  })

  it('finds what to push out at once on every keep past its bound, however many entries were moved or dropped before', () => {
    // Found by a walk of the map from its first place, the next to go would
    // be reached past every place the keys moved on each use and those
    // dropped have left there since the map was last rebuilt, so with the
    // cache full each keep would take longer the more uses came before it.
    // Counted here rather than timed, as a busy host stretches any time.
    const max = 20_000
    const reads = new QbitFundingTxReads({ maxOutpoints: max })
    const view = reads.begin({})
    const facts = { coinbase: false, value: 10_000, script: ACCOUNT_SCRIPT }
    let next = 0
    // Each keep is checked to leave the order of use ending at transactions
    // kept, so a push-out that leaves the one it pushed out in the order fails
    // at once instead of making the next push-out loop; the measured keeps
    // below skip it, as its lookups would be counted with theirs.
    const keepNext = (count: number, checked = true): void => {
      for (const end = next + count; next < end; next += 1) {
        view.keep(txidOf(next), 0, facts)
        if (checked && !endsKept(reads)) expect.unreachable(`order of use after keep ${next}`)
      }
    }
    keepNext(max)
    // Every transaction used three ways, a quarter of them forgotten and as
    // many kept in their place, then as many pushed out as it holds.
    for (let tx = 0; tx < max; tx += 1) view.touch(txidOf(tx))
    for (let tx = 0; tx < max; tx += 1) view.get(txidOf(tx), [{ vout: 0 }])
    for (let tx = 0; tx < max; tx += 1) view.keep(txidOf(tx), 0, facts)
    for (let tx = 0; tx < max; tx += 4) view.forget(txidOf(tx))
    keepNext(max / 4)
    // Each transaction forgotten left the order of use with its facts.
    expect(orderOfUse(reads).problems).toEqual([])
    keepNext(max)
    expect(reads.size).toBe(max)
    expect(orderOfUse(reads).problems).toEqual([])

    const walks = [
      vi.spyOn(Map.prototype, Symbol.iterator),
      vi.spyOn(Map.prototype, 'entries'),
      vi.spyOn(Map.prototype, 'keys'),
      vi.spyOn(Map.prototype, 'values'),
      vi.spyOn(Map.prototype, 'forEach'),
    ]
    const lookups = [
      vi.spyOn(Map.prototype, 'get'),
      vi.spyOn(Map.prototype, 'set'),
      vi.spyOn(Map.prototype, 'has'),
      vi.spyOn(Map.prototype, 'delete'),
    ]
    // Counted and cleared after each keep, and the first keep that walks or
    // looks far is the last: the checks below fail on it before thousands
    // like it fill the heap with the spies' records.
    const counted = (spies: { mock: { calls: unknown[] }; mockClear: () => unknown }[]): number => {
      let sum = 0
      for (const spy of spies) {
        sum += spy.mock.calls.length
        spy.mockClear()
      }
      return sum
    }
    // A keep of a new single-output transaction and the push-out it makes take
    // 7 lookups however many uses and drops came before: the new key, its
    // shared script, its entry and the newest it follows, then the oldest,
    // the one after it and its delete. A list of one output has no index to
    // drop, so nothing else is legitimate here; a walk of what is kept would
    // take thousands.
    const fewLookups = 7
    const lookedUp: number[] = []
    let walked = 0
    try {
      for (let each = 0; each < 5_000; each += 1) {
        keepNext(1, false)
        walked += counted(walks)
        const looked = counted(lookups)
        lookedUp.push(looked)
        if (walked > 0 || looked > fewLookups) break
      }
    } finally {
      for (const spy of [...walks, ...lookups]) spy.mockRestore()
    }
    // No walk of the map, and no keep looking up more than those 7.
    expect(walked).toBe(0)
    expect(Math.max(...lookedUp)).toBeLessThanOrEqual(fewLookups)
    // The least recently used went, one per keep, the transaction just kept never.
    expect(reads.size).toBe(max)
    expect(view.has(txidOf(next - max - 1), 0)).toBe(false)
    for (const tx of [next - max, next - 5_001, next - 1]) {
      expect(view.has(txidOf(tx), 0)).toBe(true)
    }
    expect(orderOfUse(reads).problems).toEqual([])
  })

  it("lets go of the index of a transaction's outputs with its facts: when forgotten, pushed out or cleared", () => {
    const reads = new QbitFundingTxReads({ maxOutpoints: 100 })
    const indexes = (): Map<string, unknown> => (reads as any).indexes
    const view = reads.begin({})
    const facts = { coinbase: false, value: 10_000, script: ACCOUNT_SCRIPT }
    const payMany = (tx: number): void => {
      for (let vout = 0; vout < 40; vout += 1) view.keep(txidOf(tx), vout, facts)
    }

    // A transaction of 16 outputs is a list alone; one more and it has an index.
    for (let vout = 0; vout < 16; vout += 1) view.keep(txidOf(1), vout, facts)
    expect(indexes().size).toBe(0)
    view.keep(txidOf(1), 16, facts)
    expect(indexes().size).toBe(1)

    view.forget(txidOf(1))
    expect(indexes().size).toBe(0)

    payMany(2)
    payMany(3)
    expect(indexes().size).toBe(2)
    // Past 100 outputs, the oldest transaction goes, its index with it.
    payMany(4)
    expect(view.has(txidOf(2), 0)).toBe(false)
    expect(indexes().size).toBe(2)

    reads.clear()
    expect(indexes().size).toBe(0)
  })
})

describe('which transactions the funding facts cache pushes out (#209)', () => {
  const factsOf = (value: number): QbitFundingOutputFacts => ({
    coinbase: false,
    value,
    script: ACCOUNT_SCRIPT,
  })

  it('pushes out the least recently used transaction, never one just kept again, served or touched', () => {
    const reads = new QbitFundingTxReads({ maxOutpoints: 4 })
    const view = reads.begin({})
    const kept = (): number[] =>
      Array.from({ length: 9 }, (_, tx) => tx).filter(tx => view.has(txidOf(tx), 0))
    for (let tx = 1; tx <= 4; tx += 1) view.keep(txidOf(tx), 0, factsOf(tx))

    // Each time the least recently used is used, then one more kept: the
    // next goes instead.
    expect(view.keep(txidOf(1), 0, factsOf(10)), 'kept again').toBe(false)
    view.keep(txidOf(5), 0, factsOf(5))
    expect(kept()).toEqual([1, 3, 4, 5])
    expect(view.get(txidOf(3), [{ vout: 0 }]), 'served').toEqual([
      { output: { vout: 0 }, facts: factsOf(3) },
    ])
    view.keep(txidOf(6), 0, factsOf(6))
    expect(kept()).toEqual([1, 3, 5, 6])
    view.touch(txidOf(1))
    view.keep(txidOf(7), 0, factsOf(7))
    expect(kept()).toEqual([1, 3, 6, 7])
    // A new output of the least recently used: it is used before any goes.
    expect(view.keep(txidOf(3), 1, factsOf(31))).toBe(true)
    expect(kept()).toEqual([1, 3, 7])
    expect(view.has(txidOf(3), 1)).toBe(true)
    expect(reads.size).toBe(4)
    // Asked whether its facts are kept, which is not a use, the oldest still goes.
    expect(view.has(txidOf(1), 0)).toBe(true)
    view.keep(txidOf(8), 0, factsOf(8))
    expect(kept()).toEqual([3, 7, 8])
    expect(view.get(txidOf(3), [{ vout: 1 }])?.[0]?.facts).toEqual(factsOf(31))
  })

  it('pushes out a transaction whole, of 17 outputs or of 3, and no more transactions than it must', () => {
    const reads = new QbitFundingTxReads({ maxOutpoints: 21 })
    const indexes = (reads as unknown as { indexes: Map<string, unknown> }).indexes
    const view = reads.begin({})
    for (let vout = 0; vout < 17; vout += 1) view.keep(txidOf(1), vout, factsOf(vout + 1))
    for (let vout = 0; vout < 3; vout += 1) view.keep(txidOf(2), vout, factsOf(vout + 1))
    view.keep(txidOf(3), 0, factsOf(3))
    expect(reads.size).toBe(21)
    expect(indexes.size).toBe(1)

    // One output more: the 17 go together, their index with them, and only they.
    view.keep(txidOf(4), 0, factsOf(4))
    expect(reads.size).toBe(5)
    expect(indexes.size).toBe(0)
    for (let vout = 0; vout < 17; vout += 1) expect(view.has(txidOf(1), vout)).toBe(false)
    for (let vout = 0; vout < 3; vout += 1) expect(view.has(txidOf(2), vout)).toBe(true)
    // Out of the order of use too, before another push-out could reach it.
    expect(orderOfUse(reads).problems).toEqual([])

    // Full again, then one more: the three go together, and the next stays.
    for (let tx = 5; tx <= 20; tx += 1) view.keep(txidOf(tx), 0, factsOf(tx))
    expect(reads.size).toBe(21)
    view.keep(txidOf(21), 0, factsOf(21))
    expect(reads.size).toBe(19)
    for (let vout = 0; vout < 3; vout += 1) expect(view.has(txidOf(2), vout)).toBe(false)
    expect(view.has(txidOf(3), 0)).toBe(true)
    expect(orderOfUse(reads).problems).toEqual([])
  })

  it('keeps nothing at a bound of 0: each transaction kept pushes itself out at once', () => {
    const reads = new QbitFundingTxReads({ maxOutpoints: 0 })
    const view = reads.begin({})
    const empty = { order: [], problems: [] }
    // Each fact is new, and gone with its transaction before the keep returns.
    expect(view.keep(txidOf(1), 0, factsOf(1))).toBe(true)
    expect(orderOfUse(reads)).toEqual(empty)
    for (let vout = 0; vout < 17; vout += 1) {
      expect(view.keep(txidOf(2), vout, factsOf(vout + 1)), `keep 2:${vout}`).toBe(true)
      expect(orderOfUse(reads), `order of use after keep 2:${vout}`).toEqual(empty)
    }
    expect(view.keep(txidOf(1), 0, factsOf(1)), 'kept again').toBe(true)
    expect(reads.size).toBe(0)
    expect(view.has(txidOf(1), 0)).toBe(false)
    expect(view.get(txidOf(2), [{ vout: 0 }])).toBeUndefined()
    view.touch(txidOf(1))
    view.forget(txidOf(2))
    expect(orderOfUse(reads)).toEqual(empty)
  })

  it('stops pushing out once it keeps nothing, should its count ever pass what it keeps', () => {
    const reads = new QbitFundingTxReads({ maxOutpoints: 4 })
    const view = reads.begin({})
    for (let tx = 1; tx <= 5; tx += 1) view.keep(txidOf(tx), 0, factsOf(tx))
    // Full, then one more: the oldest went, and left the order of use, before
    // the push-out below takes several in one keep.
    expect(view.has(txidOf(1), 0)).toBe(false)
    expect(orderOfUse(reads).problems).toEqual([])
    // Nothing counts more than it keeps; forced here, as a fault elsewhere might.
    const counted = reads as unknown as { outpoints: number }
    counted.outpoints += 10
    // All it keeps goes, the transaction just kept last, and the keep returns
    // without throwing or going round again.
    expect(view.keep(txidOf(6), 0, factsOf(6))).toBe(true)
    for (let tx = 2; tx <= 6; tx += 1) expect(view.has(txidOf(tx), 0)).toBe(false)
    expect(orderOfUse(reads)).toEqual({ order: [], problems: [] })
    // The count stays wrong until a clear, 10 with nothing kept: no keep
    // repairs it, and a change that does should change these lines too.
    expect(reads.size).toBe(10)
    // Every keep after it goes the same way, until a clear counts afresh.
    expect(view.keep(txidOf(7), 0, factsOf(7))).toBe(true)
    expect(view.has(txidOf(7), 0)).toBe(false)
    expect(reads.size).toBe(10)
    reads.clear()
    const fresh = reads.begin({})
    expect(fresh.keep(txidOf(8), 0, factsOf(8))).toBe(true)
    expect(fresh.has(txidOf(8), 0)).toBe(true)
    expect(reads.size).toBe(1)
  })

  it.each([
    [11, 64],
    [12, 64],
    [13, 40],
    [14, 17],
    [15, 1],
  ])(
    'serves, keeps and pushes out as the rules say, its order of use, facts and indexes agreeing after every step, mostly at its bound (seed %i, at most %i outputs)',
    (seed, max) => {
      const random = seeded(seed)
      const pick = (below: number): number => Math.floor(random() * below)
      const pickOf = <T>(items: readonly T[]): T => items[pick(items.length)] as T
      const reads = new QbitFundingTxReads({ maxOutpoints: max })
      const scopes = (reads as unknown as { scopes: WeakMap<object, number> }).scopes
      // Two clients, as for two networks, sharing the bound; the model keeps
      // by the cache's own keys.
      const begin = (): { view: QbitFundingFactsView; prefix: string } => {
        const client = {}
        const view = reads.begin(client)
        return { view, prefix: `${scopes.get(client)}:` }
      }
      let clients = [begin(), begin()]
      let reference = new ReferenceFacts(max)
      // Transactions 0 to 3 pay the address 40 times, 4 to 7 17 times, 8 to
      // 11 16 times, 12 to 23 three times and the rest once.
      const outputsOf = (tx: number): number =>
        tx < 4 ? 40 : tx < 8 ? 17 : tx < 12 ? 16 : tx < 24 ? 3 : 1
      const factsOf = (): QbitFundingOutputFacts => ({
        coinbase: random() < 0.1,
        value: 1 + pick(1_000_000),
        script: random() < 0.5 ? ACCOUNT_SCRIPT : OTHER_SCRIPT,
      })
      // A transaction the model keeps, half the time, else any.
      const target = (): { view: QbitFundingFactsView; key: string; txid: string; tx?: number } => {
        const keys = [...modelOf(reference).keys()]
        if (keys.length > 0 && random() < 0.5) {
          const key = pickOf(keys)
          const client = clients.find(({ prefix }) => key.startsWith(prefix))!
          return { view: client.view, key, txid: key.slice(client.prefix.length) }
        }
        const client = pickOf(clients)
        const tx = pick(48)
        return { view: client.view, key: client.prefix + txidOf(tx), txid: txidOf(tx), tx }
      }
      const steps = 12_000
      let atBound = 0
      let pushes = 0
      for (let step = 0; step < steps; step += 1) {
        const roll = random()
        const held = reference.outpoints
        let added = 0
        let label: string
        if (roll < 0.45) {
          // A run of outputs kept, as a classification keeps a group's; any
          // kept already are replaced, adding nothing.
          const client = pickOf(clients)
          const tx = pick(48)
          const from = pick(outputsOf(tx))
          const count = 1 + pick(outputsOf(tx) > 3 ? 20 : 2)
          for (let vout = from; vout < Math.min(outputsOf(tx), from + count); vout += 1) {
            const facts = factsOf()
            const isNew = reference.keep(client.prefix + txidOf(tx), vout, facts)
            if (isNew) added += 1
            const message = `keep ${client.prefix}${tx}:${vout} at step ${step}`
            expect(client.view.keep(txidOf(tx), vout, facts), message).toBe(isNew)
            // Each keep of the run may push some out: checked after each.
            expect(disagreements(reads, reference), message).toEqual([])
          }
          label = 'keep'
        } else if (roll < 0.55) {
          // An output kept already, kept again with other facts: a use only.
          const { view, key, txid } = target()
          const vouts = [...(modelOf(reference).get(key)?.keys() ?? [0])]
          const vout = pickOf(vouts)
          const facts = factsOf()
          const isNew = reference.keep(key, vout, facts)
          if (isNew) added += 1
          const message = `keep again ${key}:${vout} at step ${step}`
          expect(view.keep(txid, vout, facts), message).toBe(isNew)
          label = 'keep again'
        } else if (roll < 0.7) {
          // Some outputs of a transaction served, all kept or not.
          const { view, key, txid, tx } = target()
          const vouts =
            tx === undefined
              ? [...(modelOf(reference).get(key)?.keys() ?? [])]
              : Array.from({ length: outputsOf(tx) }, (_, vout) => vout)
          const outputs = vouts
            .filter(() => random() < 0.6)
            .slice(0, 24)
            .map(vout => ({ vout }))
          expect(view.get(txid, outputs), `get ${key} at step ${step}`).toEqual(
            reference.get(key, outputs)
          )
          label = 'get'
        } else if (roll < 0.78) {
          const { view, key, txid } = target()
          const vout = pick(40)
          const message = `has ${key}:${vout} at step ${step}`
          expect(view.has(txid, vout), message).toBe(reference.has(key, vout))
          label = 'has'
        } else if (roll < 0.97) {
          const { view, key, txid } = target()
          view.touch(txid)
          reference.touch(key)
          label = 'touch'
        } else if (roll < 0.997) {
          const { view, key, txid } = target()
          view.forget(txid)
          reference.forget(key)
          label = 'forget'
        } else {
          reads.clear()
          clients = [begin(), begin()]
          reference = new ReferenceFacts(max)
          label = 'clear'
        }
        // Short of its bound by less than a long list, or pushing some out.
        const pushed = label.startsWith('keep') && reference.outpoints < held + added
        if (pushed) pushes += 1
        if (pushed || held >= max - 16) atBound += 1
        expect(reads.size, `size after ${label} at step ${step}`).toBe(reference.outpoints)
        expect(disagreements(reads, reference), `after ${label} at step ${step}`).toEqual([])
      }
      // At its bound on most steps (83% and more for these seeds), and
      // pushing some out on many (16% and more).
      expect(atBound / steps).toBeGreaterThan(0.75)
      expect(pushes / steps).toBeGreaterThan(0.12)
    },
    // A second or two alone; a loaded host has stretched such tests threefold and more.
    60_000
  )
})
