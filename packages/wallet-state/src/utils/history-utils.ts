import { TxHistoryItem } from '@qbit/wallet-shared'

/**
 * Pending txids from the previous list that deserve a live status probe
 * because they are absent from the freshly fetched first page.
 *
 * A full page of pending items may have truncated the mempool, but missing
 * rows still need a lifecycle probe: the live verdict, rather than page
 * absence, decides whether each row is retained, dropped or marked replaced.
 */
export function detectReplacedCandidates(
  previous: TxHistoryItem[],
  fresh: TxHistoryItem[]
): TxHistoryItem[] {
  const freshTxids = new Set(fresh.map(item => item.txid))
  return previous.filter(
    item => item.confirmations === 0 && !item.replaced && !freshTxids.has(item.txid)
  )
}

export type ReplacedCandidateResolution = {
  txid: string
  /** Live node verdict: gone = evicted/replaced; confirmed = paged out, not replaced. */
  state: 'confirmed' | 'pending' | 'gone'
}

export const MAX_LIFECYCLE_PROBES_PER_REFRESH = 60
const LIFECYCLE_PROBE_CONCURRENCY = 8

/**
 * Resolve candidate lifecycles with a bounded request budget. The retained
 * pending set can grow well past one page across refreshes, so each refresh
 * probes at most `maxProbes` candidates through a small worker pool instead
 * of one unbounded concurrent request per row. A failed probe resolves as
 * unverified pending; candidates beyond the budget get no resolution at all.
 * Either way the row is retained pending and re-probed by a later refresh.
 *
 * The candidate list keeps a stable order across refreshes, so a fixed
 * `slice(0, maxProbes)` would starve every candidate past the budget while
 * the front ones stay pending. `startIndex` rotates the probe window: the
 * caller advances it by the probe count each refresh so all retained
 * candidates are eventually checked.
 */
export async function resolveReplacedCandidates(
  candidates: readonly TxHistoryItem[],
  probe: (txid: string) => Promise<{ state: ReplacedCandidateResolution['state'] }>,
  options: { maxProbes?: number; concurrency?: number; startIndex?: number } = {}
): Promise<(ReplacedCandidateResolution & { verified: boolean })[]> {
  const maxProbes = options.maxProbes ?? MAX_LIFECYCLE_PROBES_PER_REFRESH
  const concurrency = options.concurrency ?? LIFECYCLE_PROBE_CONCURRENCY
  const start = candidates.length > 0 ? (options.startIndex ?? 0) % candidates.length : 0
  const bounded = Array.from(
    { length: Math.min(maxProbes, candidates.length) },
    (_, offset) => candidates[(start + offset) % candidates.length]!
  )
  const resolutions = new Array<ReplacedCandidateResolution & { verified: boolean }>(bounded.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, bounded.length) }, async () => {
    while (nextIndex < bounded.length) {
      const index = nextIndex
      nextIndex += 1
      const txid = bounded[index]!.txid
      try {
        const { state } = await probe(txid)
        resolutions[index] = { txid, state, verified: true }
      } catch (error) {
        resolutions[index] = { txid, state: 'pending', verified: false }
      }
    }
  })
  await Promise.all(workers)
  return resolutions
}

/**
 * Build the list to store: the fresh page is the source of truth for every
 * txid it contains; candidates verified 'gone' are retained flagged
 * `replaced`; confirmed candidates are dropped from page-one session state;
 * pending candidates and pending txs without a verdict retain their last-known
 * row unflagged. Previously-replaced txs that remain absent are carried forward
 * so they never silently vanish. The result keeps active pending rows first
 * and sorts newest-first within each lifecycle group.
 */
export function buildHistoryList(
  previous: TxHistoryItem[],
  fresh: TxHistoryItem[],
  resolutions: ReplacedCandidateResolution[]
): TxHistoryItem[] {
  const freshTxids = new Set(fresh.map(item => item.txid))
  const resolutionByTxid = new Map(resolutions.map(item => [item.txid, item.state]))
  const carriedPrevious = previous.flatMap(item => {
    if (freshTxids.has(item.txid)) return []
    if (item.replaced) return [item]
    if (item.confirmations !== 0) return []

    const state = resolutionByTxid.get(item.txid)
    if (state === 'confirmed') return []
    if (state === 'gone') return [{ ...item, replaced: true }]
    return [item]
  })
  return [...fresh, ...carriedPrevious].sort((a, b) => {
    const aPending = a.confirmations === 0 && !a.replaced
    const bPending = b.confirmations === 0 && !b.replaced
    if (aPending !== bPending) return aPending ? -1 : 1
    return (b.timestamp ?? 0) - (a.timestamp ?? 0)
  })
}
