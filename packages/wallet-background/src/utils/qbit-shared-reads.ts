/**
 * How a caller's version stands to the running read's: the same, later
 * (its read replaces the running one), or another that is not later.
 */
export type QbitReadVersionOrder = 'same' | 'later' | 'other'

/**
 * One shared read per key at a time, which stops once nothing waits for it.
 * Each read is for a `version` (for the send screen's outputs, the state of
 * the address's history its statistics showed). A caller that asks while a
 * read for its key is running is placed by how its version stands to that
 * read's (`order`):
 *
 * - The same: it joins the running read.
 * - Later: its read replaces the running one, which is aborted, and the
 *   callers that were waiting for it wait for the new one instead, whose
 *   answer is the later.
 * - Another, not later: it never gets the running read's answer, which is
 *   for a state it has not seen, and it does not replace that read either.
 *   It reads on its own, and the running read carries on for its callers.
 *   A version that cannot be told apart from an older one (an eviction, or
 *   a lagging node behind a load balancer answering out of order) is one of
 *   these, so such answers cost a read each but cannot keep restarting the
 *   shared one.
 *
 * Once a read settles the next caller starts a new one, so no answer
 * outlives its read. A failure reaches every caller still waiting and is not
 * kept.
 *
 * A caller may pass a signal: when it aborts, that caller stops waiting,
 * and once no caller waits for a read any more the read is aborted through
 * the signal it was started with. A caller without one waits until the end.
 *
 * Keys are scoped by an object (the API client the read goes through), held
 * weakly, so a client the controller drops takes its reads with it and a new
 * client for the same network never joins a read made through the old one.
 */
export class QbitReplaceableReads<T, V> {
  private readonly reads = new WeakMap<object, Map<string, SharedRead<T, V>>>()

  /** `order(candidate, running)`: how a caller at `candidate` stands to a read for `running`. */
  constructor(private readonly order: (candidate: V, running: V) => QbitReadVersionOrder) {}

  run(
    scope: object,
    key: string,
    version: V,
    read: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    let scoped = this.reads.get(scope)
    if (!scoped) {
      scoped = new Map()
      this.reads.set(scope, scoped)
    }
    const running = scoped.get(key)
    const order = running ? this.order(version, running.version) : 'later'
    if (order === 'same') return this.wait(scoped, key, running!, signal)
    const current = this.start(scoped, key, version, read)
    // Left out of `scoped`, so nobody joins it and the running read stays.
    if (order === 'other') return this.wait(scoped, key, current, signal)
    scoped.set(key, current)
    if (running) {
      // Its callers move to the new read, which they keep running.
      running.replacedBy = current
      current.waiters += running.waiters
      running.waiters = 0
      running.follow(current.answer)
      running.controller.abort(new Error('replaced by a newer read'))
    }
    return this.wait(scoped, key, current, signal)
  }

  /** A read for `version`; others join it only once `run` places it under `key`. */
  private start(
    scoped: Map<string, SharedRead<T, V>>,
    key: string,
    version: V,
    read: (signal: AbortSignal) => Promise<T>
  ): SharedRead<T, V> {
    const controller = new AbortController()
    let follow: (answer: Promise<T>) => void = () => undefined
    const answer = new Promise<T>(resolve => (follow = resolve))
    // A read every caller has left fails with nobody to tell.
    answer.catch(() => undefined)
    const entry: SharedRead<T, V> = { version, controller, answer, follow, waiters: 0 }
    const own = Promise.resolve().then(() => read(controller.signal))
    // The entry is dropped before its answer settles, so a caller that has
    // seen it settle starts a fresh read.
    const settled = (): void => {
      if (scoped.get(key) === entry) scoped.delete(key)
      if (!entry.replacedBy) follow(own)
    }
    own.then(settled, settled)
    return entry
  }

  private wait(
    scoped: Map<string, SharedRead<T, V>>,
    key: string,
    entry: SharedRead<T, V>,
    signal: AbortSignal | undefined
  ): Promise<T> {
    entry.waiters += 1
    if (!signal) return entry.answer
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        reject(signal.reason)
        this.leave(scoped, key, entry)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      entry.answer.then(
        value => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        error => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        }
      )
    })
  }

  /** A caller of `entry`, or of the read that replaced it, stopped waiting. */
  private leave(scoped: Map<string, SharedRead<T, V>>, key: string, entry: SharedRead<T, V>): void {
    let current = entry
    while (current.replacedBy) current = current.replacedBy
    current.waiters -= 1
    if (current.waiters > 0) return
    // Nobody waits for it: it stops, and the next caller starts afresh.
    if (scoped.get(key) === current) scoped.delete(key)
    current.controller.abort(new Error('nothing waits for this read'))
  }
}

interface SharedRead<T, V> {
  readonly version: V
  /** Aborts the read: every caller left, or a later read replaced it. */
  readonly controller: AbortController
  /** The read's answer, or the answer of the read that replaced it. */
  readonly answer: Promise<T>
  /** Settle `answer`; the first call wins. */
  readonly follow: (answer: Promise<T>) => void
  /** Callers waiting for it; a caller without a signal never leaves. */
  waiters: number
  replacedBy?: SharedRead<T, V>
}

/**
 * The latest answer kept per scope and slot. A read takes its place in line
 * when it starts (`start`), and its answer replaces the kept one unless the
 * kept one comes from a read that started later: what a read found, however
 * little, never ranks it, so after an eviction a later read that finds less
 * history still replaces an earlier one. Callers keep only answers to reads
 * that completed. `clear` forgets every answer, and a read that started
 * before it keeps nothing. Kept in memory only, for the slots most recently
 * used, and scopes are held weakly, as above.
 */
export class QbitLatestAnswers<T> {
  private answers = new WeakMap<object, Map<string, { order: number; value: T }>>()
  private started = 0
  /** The last place in line before the latest `clear`. */
  private cleared = 0

  /** Keeps answers for at most `slotsPerScope` slots per scope, the most recently used. */
  constructor(private readonly slotsPerScope = Infinity) {}

  /** The place in line of a read starting now, to `keep` its answer with. */
  start(): number {
    return ++this.started
  }

  keep(scope: object, slot: string, order: number, value: T): void {
    if (order <= this.cleared) return
    let scoped = this.answers.get(scope)
    if (!scoped) {
      scoped = new Map()
      this.answers.set(scope, scoped)
    }
    const kept = scoped.get(slot)
    if (kept && kept.order > order) return
    // Last in the map's order is the most recently used.
    scoped.delete(slot)
    scoped.set(slot, { order, value })
    for (const oldest of scoped.keys()) {
      if (scoped.size <= this.slotsPerScope) break
      scoped.delete(oldest)
    }
  }

  /** The answer kept for `slot`, which counts as a use of it. */
  latest(scope: object, slot: string): T | undefined {
    const scoped = this.answers.get(scope)
    const kept = scoped?.get(slot)
    if (!scoped || !kept) return undefined
    scoped.delete(slot)
    scoped.set(slot, kept)
    return kept.value
  }

  /** Forget every answer, including those of reads still running. */
  clear(): void {
    this.answers = new WeakMap()
    this.cleared = this.started
  }
}
