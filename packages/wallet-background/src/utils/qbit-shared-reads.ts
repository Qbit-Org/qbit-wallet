/**
 * One read per key at a time, which stops once nothing waits for it. Each
 * read is for a `version` (for the send screen's outputs, how far the
 * address's history had got). A caller that asks while a read for its key
 * is running joins it, unless its version is newer (`newer`): then its read
 * replaces the running one, which is aborted, and the callers that were
 * waiting for it wait for the new one instead, whose answer is the newer.
 * A version that is the same, older or not comparable joins, so answers
 * that arrive out of order (a lagging node behind a load balancer) cannot
 * keep restarting a read. Once a read settles the next caller starts a new
 * one, so no answer outlives its read. A failure reaches every caller still
 * waiting and is not kept.
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

  /** `newer(candidate, running)`: whether a read for `candidate` should replace one for `running`. */
  constructor(private readonly newer: (candidate: V, running: V) => boolean) {}

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
    let current = scoped.get(key)
    if (!current || this.newer(version, current.version)) {
      const replaced = current
      current = this.start(scoped, key, version, read)
      if (replaced) {
        // Its callers move to the new read, which they keep running.
        replaced.replacedBy = current
        current.waiters += replaced.waiters
        replaced.waiters = 0
        replaced.follow(current.answer)
        replaced.controller.abort(new Error('replaced by a newer read'))
      }
    }
    return this.wait(scoped, key, current, signal)
  }

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
    scoped.set(key, entry)
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
  /** Aborts the read: every caller left, or a newer read replaced it. */
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
 * that completed. Kept in memory only, and scopes are held weakly, as above.
 */
export class QbitLatestAnswers<T> {
  private readonly answers = new WeakMap<object, Map<string, { order: number; value: T }>>()
  private started = 0

  /** The place in line of a read starting now, to `keep` its answer with. */
  start(): number {
    return ++this.started
  }

  keep(scope: object, slot: string, order: number, value: T): void {
    let scoped = this.answers.get(scope)
    if (!scoped) {
      scoped = new Map()
      this.answers.set(scope, scoped)
    }
    const kept = scoped.get(slot)
    if (kept && kept.order > order) return
    scoped.set(slot, { order, value })
  }

  /** The answer kept for `slot`. */
  latest(scope: object, slot: string): T | undefined {
    return this.answers.get(scope)?.get(slot)?.value
  }
}
