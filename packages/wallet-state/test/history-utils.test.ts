import { describe, expect, it, vi } from 'vitest'

import { TxHistoryItem } from '@qbit/wallet-shared'
import {
  buildHistoryList,
  detectReplacedCandidates,
  resolveReplacedCandidates,
} from '../src/utils/history-utils'

function item(
  txid: string,
  confirmations: number,
  timestamp: number,
  extra: Partial<TxHistoryItem> = {}
) {
  return {
    txid,
    confirmations,
    timestamp,
    address: 'qb1qx',
    amount: '1',
    symbol: 'QBT',
    ...extra,
  } as TxHistoryItem
}

describe('detectReplacedCandidates', () => {
  it('reports missing pending txs when the fresh page contains confirmed rows', () => {
    const previous = [item('aa', 0, 100), item('bb', 0, 90)]
    const fresh = [item('bb', 0, 90), item('cc', 3, 80)]
    expect(detectReplacedCandidates(previous, fresh).map(i => i.txid)).toEqual(['aa'])
  })

  it('reports missing pending txs even when a full page may have truncated the mempool', () => {
    const previous = [item('aa', 0, 100)]
    const fresh = Array.from({ length: 20 }, (_, index) => item(`fresh-${index}`, 0, 90 - index))
    expect(detectReplacedCandidates(previous, fresh).map(i => i.txid)).toEqual(['aa'])
  })

  it('reports missing pending txs on a short all-pending page', () => {
    const previous = [item('aa', 0, 100)]
    const fresh = [item('bb', 0, 90)]
    expect(detectReplacedCandidates(previous, fresh).map(i => i.txid)).toEqual(['aa'])
  })

  it('never re-reports already-replaced or confirmed items', () => {
    const previous = [item('aa', 0, 100, { replaced: true }), item('bb', 5, 90)]
    const fresh = [item('cc', 1, 80)]
    expect(detectReplacedCandidates(previous, fresh)).toEqual([])
  })
})

describe('buildHistoryList', () => {
  it('flags only node-verified gone candidates and keeps them visible', () => {
    const previous = [item('aa', 0, 100), item('bb', 0, 95)]
    const fresh = [item('cc', 1, 90)]
    const merged = buildHistoryList(previous, fresh, [
      { txid: 'aa', state: 'gone' },
      { txid: 'bb', state: 'confirmed' },
    ])
    expect(merged.map(i => i.txid)).toEqual(['aa', 'cc'])
    expect(merged[0]!.replaced).toBe(true)
  })

  it('retains pending candidates unflagged and drops confirmed candidates', () => {
    const previous = [item('aa', 0, 100), item('bb', 0, 95)]
    const fresh = [item('cc', 2, 90)]
    const merged = buildHistoryList(previous, fresh, [
      { txid: 'aa', state: 'pending' },
      { txid: 'bb', state: 'confirmed' },
    ])
    expect(merged.map(i => [i.txid, i.replaced ?? false])).toEqual([
      ['aa', false],
      ['cc', false],
    ])
  })

  it('retains a paged-out pending tx unflagged after its lifecycle probe says pending', () => {
    const previous = [item('aa', 0, 100)]
    const fresh = [item('bb', 0, 90), item('cc', 0, 80)]
    const resolutions = detectReplacedCandidates(previous, fresh).map(item => ({
      txid: item.txid,
      state: 'pending' as const,
    }))
    const merged = buildHistoryList(previous, fresh, resolutions)
    expect(resolutions).toEqual([{ txid: 'aa', state: 'pending' }])
    expect(merged.map(i => [i.txid, i.replaced ?? false])).toEqual([
      ['aa', false],
      ['bb', false],
      ['cc', false],
    ])
  })

  it('lets fresh data win for reorged txs that flip back to pending', () => {
    const previous = [item('aa', 3, 100)]
    const fresh = [item('aa', 0, 100)]
    const merged = buildHistoryList(previous, fresh, [])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.confirmations).toBe(0)
    expect(merged[0]!.replaced).toBeUndefined()
  })

  it('carries replaced txs forward without duplication and un-flags on reappearance', () => {
    const previous = [item('aa', 0, 100, { replaced: true }), item('bb', 0, 95, { replaced: true })]
    const fresh = [item('bb', 1, 95)]
    const once = buildHistoryList(previous, fresh, [])
    expect(once.map(i => [i.txid, i.replaced ?? false])).toEqual([
      ['aa', true],
      ['bb', false],
    ])
    const twice = buildHistoryList(once, fresh, [])
    expect(twice.filter(i => i.txid === 'aa')).toHaveLength(1)
  })

  it('sorts the merged list newest-first so date grouping stays coherent', () => {
    const previous = [item('old-replaced', 0, 50)]
    const fresh = [item('mid', 1, 100), item('newest', 0, 200)]
    const merged = buildHistoryList(previous, fresh, [{ txid: 'old-replaced', state: 'gone' }])
    expect(merged.map(i => i.txid)).toEqual(['newest', 'mid', 'old-replaced'])
  })

  it('keeps timestamp-zero pending rows ahead while sorting each lifecycle group newest-first', () => {
    const previous = [item('pending-without-time', 0, 0)]
    const fresh = [
      item('newest-confirmed', 2, 300),
      item('newest-pending', 0, 200),
      item('older-confirmed', 3, 100),
    ]
    const merged = buildHistoryList(previous, fresh, [])
    expect(merged.map(i => i.txid)).toEqual([
      'newest-pending',
      'pending-without-time',
      'newest-confirmed',
      'older-confirmed',
    ])
  })
})

describe('resolveReplacedCandidates', () => {
  it('probes at most the per-refresh budget and leaves the overflow unresolved', async () => {
    const candidates = Array.from({ length: 5 }, (_, index) => item(`tx-${index}`, 0, 1))
    const probe = vi.fn(async () => ({ state: 'gone' as const }))

    const resolutions = await resolveReplacedCandidates(candidates, probe, { maxProbes: 3 })

    expect(probe).toHaveBeenCalledTimes(3)
    expect(probe.mock.calls.map(call => call[0])).toEqual(['tx-0', 'tx-1', 'tx-2'])
    expect(resolutions).toEqual([
      { txid: 'tx-0', state: 'gone', verified: true },
      { txid: 'tx-1', state: 'gone', verified: true },
      { txid: 'tx-2', state: 'gone', verified: true },
    ])
  })

  it('rotates the probe window from startIndex, wrapping past the end', async () => {
    const candidates = Array.from({ length: 5 }, (_, index) => item(`tx-${index}`, 0, 1))
    const probe = vi.fn(async () => ({ state: 'pending' as const }))

    const resolutions = await resolveReplacedCandidates(candidates, probe, {
      maxProbes: 3,
      startIndex: 3,
    })

    expect(probe.mock.calls.map(call => call[0])).toEqual(['tx-3', 'tx-4', 'tx-0'])
    expect(resolutions.map(entry => entry.txid)).toEqual(['tx-3', 'tx-4', 'tx-0'])
  })

  it('covers every candidate across consecutive rotated refreshes', async () => {
    const candidates = Array.from({ length: 7 }, (_, index) => item(`tx-${index}`, 0, 1))
    const probe = vi.fn(async () => ({ state: 'pending' as const }))

    let cursor = 0
    const probed = new Set<string>()
    for (let refresh = 0; refresh < 3; refresh += 1) {
      const resolutions = await resolveReplacedCandidates(candidates, probe, {
        maxProbes: 3,
        startIndex: cursor,
      })
      cursor = (cursor + resolutions.length) % candidates.length
      resolutions.forEach(entry => probed.add(entry.txid))
    }

    expect(probed.size).toBe(7)
  })

  it('bounds concurrent probes to the worker pool size', async () => {
    const candidates = Array.from({ length: 6 }, (_, index) => item(`tx-${index}`, 0, 1))
    let inFlight = 0
    let maxInFlight = 0
    const release: Array<() => void> = []
    const probe = vi.fn(
      () =>
        new Promise<{ state: 'pending' }>(resolve => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          release.push(() => {
            inFlight -= 1
            resolve({ state: 'pending' })
          })
        })
    )

    const result = resolveReplacedCandidates(candidates, probe, { concurrency: 2 })
    expect(probe).toHaveBeenCalledTimes(2)

    while (release.length > 0) {
      release.shift()!()
      await Promise.resolve()
      await Promise.resolve()
    }
    const resolutions = await result

    expect(probe).toHaveBeenCalledTimes(6)
    expect(maxInFlight).toBe(2)
    expect(resolutions).toHaveLength(6)
    expect(resolutions.every(entry => entry.verified && entry.state === 'pending')).toBe(true)
  })

  it('marks failed probes as unverified pending while successes stay verified', async () => {
    const candidates = [item('tx-ok', 0, 1), item('tx-down', 0, 1)]
    const probe = vi.fn(async (txid: string) => {
      if (txid === 'tx-down') throw new Error('offline')
      return { state: 'confirmed' as const }
    })

    const resolutions = await resolveReplacedCandidates(candidates, probe)

    expect(resolutions).toEqual([
      { txid: 'tx-ok', state: 'confirmed', verified: true },
      { txid: 'tx-down', state: 'pending', verified: false },
    ])
  })
})
