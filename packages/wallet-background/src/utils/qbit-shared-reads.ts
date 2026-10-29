/**
 * One read per key at a time. A caller that asks while a read for its key is
 * still running joins that read instead of starting another; once it settles
 * the next caller starts a new one, so no answer outlives its read. A failure
 * reaches every caller that joined and is not kept.
 *
 * Keys are scoped by an object (the API client the read goes through), held
 * weakly, so a client the controller drops takes its reads with it and a new
 * client for the same network never joins a read made through the old one.
 *
 * A read started for a `slot` also leaves its answer behind: once it
 * completes, its answer and key are the slot's latest (`latest`), unless a
 * read for the slot that started after it has already completed. Nothing
 * else is kept, and only in memory.
 */
export class QbitSharedReads<T> {
  private readonly reads = new WeakMap<object, Map<string, Promise<T>>>()
  private readonly answers = new WeakMap<
    object,
    Map<string, { key: string; value: T; order: number }>
  >()
  private started = 0

  run(scope: object, key: string, read: () => Promise<T>, slot?: string): Promise<T> {
    let scoped = this.reads.get(scope)
    if (!scoped) {
      scoped = new Map()
      this.reads.set(scope, scoped)
    }
    const running = scoped.get(key)
    if (running) return running
    const reads = scoped
    const order = ++this.started
    // The entry is dropped before the returned promise settles, so a caller
    // that has seen it settle starts a fresh read. The answer is kept before
    // that, so such a caller also finds it as the slot's latest.
    const started: Promise<T> = Promise.resolve()
      .then(read)
      .then(value => {
        if (slot !== undefined) this.keep(scope, slot, key, value, order)
        return value
      })
      .finally(() => {
        if (reads.get(key) === started) reads.delete(key)
      })
    reads.set(key, started)
    return started
  }

  /** The answer of the latest completed read for `slot`, with the key it ran under. */
  latest(scope: object, slot: string): { key: string; value: T } | undefined {
    const answer = this.answers.get(scope)?.get(slot)
    return answer && { key: answer.key, value: answer.value }
  }

  private keep(scope: object, slot: string, key: string, value: T, order: number): void {
    let scoped = this.answers.get(scope)
    if (!scoped) {
      scoped = new Map()
      this.answers.set(scope, scoped)
    }
    const kept = scoped.get(slot)
    if (kept && kept.order > order) return
    scoped.set(slot, { key, value, order })
  }
}
