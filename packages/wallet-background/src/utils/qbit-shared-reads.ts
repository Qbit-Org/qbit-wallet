/**
 * One read per key at a time. A caller that asks while a read for its key is
 * still running joins that read instead of starting another; once it settles
 * the next caller starts a new one, so no answer outlives its read. A failure
 * reaches every caller that joined and is not kept.
 *
 * Keys are scoped by an object (the API client the read goes through), held
 * weakly, so a client the controller drops takes its reads with it and a new
 * client for the same network never joins a read made through the old one.
 */
export class QbitSharedReads<T> {
  private readonly reads = new WeakMap<object, Map<string, Promise<T>>>()

  run(scope: object, key: string, read: () => Promise<T>): Promise<T> {
    let scoped = this.reads.get(scope)
    if (!scoped) {
      scoped = new Map()
      this.reads.set(scope, scoped)
    }
    const running = scoped.get(key)
    if (running) return running
    const reads = scoped
    // The entry is dropped before the returned promise settles, so a caller
    // that has seen it settle starts a fresh read.
    const started: Promise<T> = Promise.resolve()
      .then(read)
      .finally(() => {
        if (reads.get(key) === started) reads.delete(key)
      })
    reads.set(key, started)
    return started
  }
}
