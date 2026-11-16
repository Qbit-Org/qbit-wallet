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
  it('walks its transactions only to push some out, not on every fact it keeps within its bound', () => {
    // Walking the map begins at its oldest place, past every place moved or
    // deleted entries left there, which using and keeping facts leave one of
    // each time. Walked on every keep, as it was, keeping facts again for
    // 100,000 transactions took 1.1 s, eight times what it takes now.
    const reads = new QbitFundingTxReads({ maxOutpoints: 2_000 })
    const view = reads.begin({})
    const facts = { coinbase: false, value: 10_000, script: ACCOUNT_SCRIPT }
    for (let tx = 0; tx < 1_000; tx += 1) view.keep(txidOf(tx), 0, facts)
    const walks = vi.spyOn(Map.prototype, Symbol.iterator)
    try {
      // Used, kept again and kept anew, all within its bound: no walk.
      for (let tx = 0; tx < 1_000; tx += 1) view.touch(txidOf(tx))
      for (let tx = 0; tx < 1_000; tx += 1) view.keep(txidOf(tx), 0, facts)
      for (let tx = 1_000; tx < 2_000; tx += 1) view.keep(txidOf(tx), 0, facts)
      expect(walks).not.toHaveBeenCalled()
      // One more than it holds: the oldest goes, found by walking from it.
      view.keep(txidOf(2_000), 0, facts)
      expect(walks).toHaveBeenCalledTimes(1)
    } finally {
      walks.mockRestore()
    }
    expect(reads.size).toBe(2_000)
    expect(view.has(txidOf(0), 0)).toBe(false)
    expect(view.has(txidOf(2_000), 0)).toBe(true)
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
