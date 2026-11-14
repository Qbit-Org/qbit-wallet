import type { EsploraTx, RequestOptions } from '@qbit-oss/api'

/**
 * The reads behind classifying an address's listed outputs (see
 * `getQbitAddressUtxosClassified` in `qbit-api`): one `/tx/:txid` per funding
 * transaction, the chain tip, and the unconfirmed ancestors of the
 * account's own change. Since the explorer's output-listing
 * limit was raised from 500 to 50,000 (see #169), an address can list tens of
 * thousands of outputs, each funded by a transaction of its own. Those reads
 * are therefore bounded (`QbitReadLimiter`), and what a funding transaction
 * says for good about the outputs it created is kept between reads
 * (`QbitFundingTxReads`), so an address whose outputs did not change is
 * classified again without reading them; a read of outputs that a send may
 * spend still reads young ones that are not coinbase outputs afresh (see
 * `QbitFundingTxReads`).
 */

/**
 * The most classification reads in flight to one explorer at a time, funding
 * transactions and ancestors together. Each read's own time budget starts
 * before the browser sends it, so thousands queued at once would spend it
 * waiting behind each other; this many keep the explorer busy (it answered
 * 2,000 parallel transaction reads in about 8 s) without that queue.
 */
export const QBIT_CLASSIFY_MAX_READS_IN_FLIGHT = 16

/**
 * The most outputs `QbitFundingTxReads` keeps the facts of by default: an
 * address at the explorer's 50,000-output listing limit fits. Each takes the
 * txid key, one small record and a map slot (scripts are shared): measured
 * in Node for a mainnet address, about 150 bytes, and about 300 once polls
 * have churned the map, so 10 to 20 MB when full.
 */
export const QBIT_FUNDING_FACTS_MAX_OUTPOINTS = 65_536

/**
 * Distinct output scripts kept for sharing between facts. An address's
 * outputs all carry its one script, so this is only a bound against an
 * explorer that answers with a new script every time.
 */
const QBIT_FUNDING_FACTS_SHARED_SCRIPTS = 256

/**
 * Reads run at most `maxInFlight` at a time. The rest wait first come, first
 * served, each for its own slot: a caller holds no place in line beyond the
 * reads it is waiting to start, so a caller that pulls its next read only
 * when one of its own ends (as a classification does) never puts thousands
 * of reads ahead of another caller's.
 *
 * A read holds its slot until it settles; a read whose signal aborts is
 * expected to settle at once, as the explorer clients' do. A wait for a slot
 * ends as soon as its signal aborts, and leaves nothing behind.
 */
export class QbitReadLimiter {
  private running = 0
  /** In arrival order; a `Set` so an abandoned wait leaves in constant time. */
  private readonly waiting = new Set<() => void>()

  constructor(readonly maxInFlight = QBIT_CLASSIFY_MAX_READS_IN_FLIGHT) {
    if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) {
      throw new Error('maxInFlight must be a positive integer')
    }
  }

  /** Reads running now. */
  get inFlight(): number {
    return this.running
  }

  /** Reads waiting for a slot. */
  get queued(): number {
    return this.waiting.size
  }

  /**
   * `read()` once a slot is free, which it holds until its promise settles.
   * Rejects with `signal.reason`, without starting it, if `signal` aborts
   * first.
   */
  run<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.running < this.maxInFlight && this.waiting.size === 0) return this.start(read)
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        signal?.removeEventListener('abort', onAbort)
        this.start(read).then(resolve, reject)
      }
      const onAbort = (): void => {
        this.waiting.delete(start)
        reject(signal?.reason)
      }
      this.waiting.add(start)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private start<T>(read: () => Promise<T>): Promise<T> {
    this.running += 1
    let reading: Promise<T>
    try {
      reading = Promise.resolve(read())
    } catch (error) {
      reading = Promise.reject(error)
    }
    // Released before the caller hears the outcome, so a caller that asks
    // for its next slot at once waits behind those already waiting.
    const release = (): void => {
      this.running -= 1
      this.startWaiting()
    }
    reading.then(release, release)
    return reading
  }

  private startWaiting(): void {
    while (this.running < this.maxInFlight) {
      const next = this.waiting.values().next()
      if (next.done) return
      this.waiting.delete(next.value)
      next.value()
    }
  }
}

/**
 * What a funding transaction says for good about one of its outputs: its
 * txid commits to its inputs and outputs, so to whether it is a coinbase
 * and to each output's value and script. The wallet takes them from the
 * explorer's answer without checking it against the txid, which is why
 * "not a coinbase" serves a read of outputs to spend only for an output deep
 * enough for it not to matter, and why facts are kept only with the script
 * of the address read (see `QbitFundingTxReads`). Nothing about
 * confirmation is here: that comes from fresh reads every time.
 */
export interface QbitFundingOutputFacts {
  readonly coinbase: boolean
  readonly value: number
  readonly script: string
}

/** The facts kept for one transaction: a list of its outputs', usually one long. */
interface QbitFundingFactsNode extends QbitFundingOutputFacts {
  readonly vout: number
  next: QbitFundingFactsNode | undefined
}

export interface QbitFundingTxReadsOptions {
  /** The most outputs whose facts are kept; `QBIT_FUNDING_FACTS_MAX_OUTPOINTS` by default. */
  maxOutpoints?: number
  /** The limiter bound per explorer client; `QBIT_CLASSIFY_MAX_READS_IN_FLIGHT` by default. */
  maxReadsInFlight?: number
  /**
   * Whether facts may be served or kept right now; the controller passes
   * whether the wallet reads unlocked. While it is false nothing is served
   * or kept, and the reads stay bounded as ever.
   */
  usable?: () => boolean
}

/**
 * The reads every classification through one explorer client shares: a
 * limiter (`QbitReadLimiter`), so the wallet as a whole keeps at most
 * `maxReadsInFlight` of them in flight to that explorer, and the facts of
 * funding transactions (`QbitFundingOutputFacts`), by client and txid, so a
 * confirmed output read once is classified again without a read. The
 * classifier (`classifyQbitUtxos` in `qbit-api`) keeps and serves them only
 * with the script of the address it reads, which every output that address's
 * listing names pays: an answer with another script is used for its one read
 * and not kept. It serves them only for an output the fresh listing reports
 * confirmed. Facts saying the transaction
 * is not a coinbase serve a read of outputs (what a send, sweep or plan
 * spends) only once the output is as deep as a coinbase output must be to
 * mature: the explorer's answer is not checked against the txid, so until
 * then a wrong one would let a send skip coinbase maturity, and the output
 * is read afresh, its answer replacing the kept one. The balance read alone,
 * whose answer is only totals, takes them at any confirmed depth, so after
 * one wrong `is_coinbase` answer it can count a reward younger than 1,000
 * blocks as Available until a read of outputs or a clear replaces the kept
 * fact; no send can select it.
 *
 * Clients are held weakly, as in `QbitLatestAnswers`: facts read through one
 * client are never served through another, so never for another network or
 * endpoint, and a client dropped takes its limiter with it. Facts are public
 * chain data, the same for any account, so the accounts on one client share
 * them; each output is still checked against the listing it is served for.
 *
 * Only the facts of outputs a classification needed are kept, at most
 * `maxOutpoints` of them, the least recently used going first. A balance
 * read whose listing names more outputs than that reads none of them one by
 * one (`getQbitSpendableBalanceV2`): each of its polls would push out the
 * facts the next needs, read without end and never finish. A read of outputs
 * for a send, sweep or plan still reads every one. A classification counts
 * every kept output of its listing used before it reads any afresh, so what
 * it then keeps pushes out other addresses' facts before its own: a listing
 * that fits is read again only where its facts were pushed out, as after a
 * switch to another account and back. `clear`
 * forgets them all, and a classification that began before it keeps nothing
 * after it and is served nothing more. The limiters are kept: reads already
 * in flight still hold their slots.
 */
export class QbitFundingTxReads {
  readonly maxOutpoints: number
  readonly maxReadsInFlight: number
  private readonly usable: () => boolean
  private readonly limiters = new WeakMap<object, QbitReadLimiter>()
  private readonly scopes = new WeakMap<object, number>()
  private nextScope = 0
  /** By `${scope}:${txid}`, least recently used first. */
  private facts = new Map<string, QbitFundingFactsNode>()
  private outpoints = 0
  private scripts = new Map<string, string>()
  /** Fresh funding reads in flight, by `${scope}:${txid}`, and how many. */
  private fetching = new Map<string, number>()
  private started = 0
  /** The last classification begun before the latest `clear`. */
  private cleared = 0

  constructor(options: QbitFundingTxReadsOptions = {}) {
    this.maxOutpoints = options.maxOutpoints ?? QBIT_FUNDING_FACTS_MAX_OUTPOINTS
    if (!Number.isSafeInteger(this.maxOutpoints) || this.maxOutpoints < 0) {
      throw new Error('maxOutpoints must be a non-negative integer')
    }
    this.maxReadsInFlight = options.maxReadsInFlight ?? QBIT_CLASSIFY_MAX_READS_IN_FLIGHT
    if (!Number.isSafeInteger(this.maxReadsInFlight) || this.maxReadsInFlight < 1) {
      throw new Error('maxReadsInFlight must be a positive integer')
    }
    this.usable = options.usable ?? ((): boolean => true)
  }

  /** The limiter of every classification read through `client`. */
  limiter(client: object): QbitReadLimiter {
    let limiter = this.limiters.get(client)
    if (!limiter) {
      limiter = new QbitReadLimiter(this.maxReadsInFlight)
      this.limiters.set(client, limiter)
    }
    return limiter
  }

  /** Outputs whose facts are kept now. */
  get size(): number {
    return this.outpoints
  }

  /**
   * The facts as one classification beginning now through `client` sees
   * them: it is served and keeps facts only until the next `clear`, and only
   * while `usable()`.
   */
  begin(client: object): QbitFundingFactsView {
    const order = ++this.started
    let scope = this.scopes.get(client)
    if (scope === undefined) {
      scope = ++this.nextScope
      this.scopes.set(client, scope)
    }
    const prefix = `${scope}:`
    const open = (): boolean => order > this.cleared && this.usable()
    return {
      get: (txid, outputs) => (open() ? this.get(prefix + txid, outputs) : undefined),
      keep: (txid, vout, facts): boolean => open() && this.keep(prefix + txid, vout, facts),
      forget: (txid): void => {
        this.forget(prefix + txid)
      },
      touch: (txid): void => {
        if (open()) this.touch(prefix + txid)
      },
      has: (txid, vout): boolean => open() && this.has(prefix + txid, vout),
      fetchingElsewhere: (txid): boolean => open() && (this.fetching.get(prefix + txid) ?? 0) > 0,
      fetch: (txid): (() => void) => {
        // A read that keeps nothing is nothing to wait for.
        if (!open()) return (): void => undefined
        const key = prefix + txid
        // Marks of reads begun before a `clear` stay in the map they were made in.
        const fetching = this.fetching
        fetching.set(key, (fetching.get(key) ?? 0) + 1)
        let done = false
        return (): void => {
          if (done) return
          done = true
          const left = (fetching.get(key) ?? 1) - 1
          if (left > 0) fetching.set(key, left)
          else fetching.delete(key)
        }
      },
    }
  }

  /** Forget every fact; classifications begun before this keep nothing more and are served nothing. */
  clear(): void {
    this.facts = new Map()
    this.outpoints = 0
    this.scripts = new Map()
    this.fetching = new Map()
    this.cleared = this.started
  }

  private get<T extends { readonly vout: number }>(
    key: string,
    outputs: readonly T[]
  ): { output: T; facts: QbitFundingOutputFacts }[] | undefined {
    const head = this.facts.get(key)
    if (!head) return undefined
    const found: { output: T; facts: QbitFundingOutputFacts }[] = []
    for (const output of outputs) {
      let node: QbitFundingFactsNode | undefined = head
      while (node && node.vout !== output.vout) node = node.next
      if (!node) return undefined
      found.push({
        output,
        facts: { coinbase: node.coinbase, value: node.value, script: node.script },
      })
    }
    // Last in the map's order is the most recently used.
    this.facts.delete(key)
    this.facts.set(key, head)
    return found
  }

  private has(key: string, vout: number): boolean {
    for (let node = this.facts.get(key); node; node = node.next) {
      if (node.vout === vout) return true
    }
    return false
  }

  private touch(key: string): void {
    const head = this.facts.get(key)
    if (!head) return
    this.facts.delete(key)
    this.facts.set(key, head)
  }

  private keep(key: string, vout: number, facts: QbitFundingOutputFacts): boolean {
    let head = this.facts.get(key)
    if (head) this.facts.delete(key)
    // The latest checked facts of an output replace any kept before.
    let replaced = false
    if (head?.vout === vout) {
      head = head.next
      this.outpoints -= 1
      replaced = true
    } else {
      for (let node = head; node?.next; node = node.next) {
        if (node.next.vout === vout) {
          node.next = node.next.next
          this.outpoints -= 1
          replaced = true
          break
        }
      }
    }
    this.facts.set(key, {
      vout,
      value: facts.value,
      script: this.shared(facts.script),
      coinbase: facts.coinbase,
      next: head,
    })
    this.outpoints += 1
    for (const [oldest, oldestHead] of this.facts) {
      if (this.outpoints <= this.maxOutpoints) break
      this.facts.delete(oldest)
      this.outpoints -= this.countOf(oldestHead)
    }
    return !replaced
  }

  private forget(key: string): void {
    const head = this.facts.get(key)
    if (!head) return
    this.facts.delete(key)
    this.outpoints -= this.countOf(head)
  }

  private countOf(head: QbitFundingFactsNode | undefined): number {
    let count = 0
    for (let node = head; node; node = node.next) count += 1
    return count
  }

  /** One string per distinct script, shared by every fact that carries it. */
  private shared(script: string): string {
    const known = this.scripts.get(script)
    if (known !== undefined) return known
    if (this.scripts.size >= QBIT_FUNDING_FACTS_SHARED_SCRIPTS) this.scripts = new Map()
    this.scripts.set(script, script)
    return script
  }
}

/** The facts as one classification sees them (`QbitFundingTxReads.begin`); txids in lower case. */
export interface QbitFundingFactsView {
  /**
   * Each of `outputs` of `txid` with its facts, in that order, or undefined
   * unless all are kept. A use of them.
   */
  get<T extends { readonly vout: number }>(
    txid: string,
    outputs: readonly T[]
  ): { output: T; facts: QbitFundingOutputFacts }[] | undefined
  /**
   * Keep the checked facts of output `vout` of `txid`; whether they are new,
   * that is the output's facts were not kept already (nothing is, after a
   * `clear` or while the facts may not be used).
   */
  keep(txid: string, vout: number, facts: QbitFundingOutputFacts): boolean
  /** Drop what is kept of `txid`. */
  forget(txid: string): void
  /** Count what is kept of `txid` used now, as `get` does, without serving it. */
  touch(txid: string): void
  /** Whether the facts of output `vout` of `txid` are kept now; not a use of them. */
  has(txid: string, vout: number): boolean
  /** Whether another classification is reading `txid` for its facts right now. */
  fetchingElsewhere(txid: string): boolean
  /** Mark a read of `txid` for its facts as in flight; the function returned unmarks it. */
  fetch(txid: string): () => void
}

/** One read of a classification (`QbitClassificationReads.tx`). */
interface QbitClassificationRead {
  read: Promise<EsploraTx>
  /** Started for the transaction's own outputs, not by an ancestor's walk. */
  forFacts: boolean
  /** A read for its own outputs that joined this walk's read: read afresh should this one fail. */
  joined?: Promise<EsploraTx>
}

/** The client calls a classification reads transactions through. */
export interface QbitClassifyTxClient {
  getTx(txid: string, options?: RequestOptions): Promise<EsploraTx>
}

/**
 * The reads of one classification: each transaction it needs read once,
 * through the limiter, under one signal that aborts once the caller's does or
 * the classification fails, so a failure stops every read still waiting for
 * a slot and cancels those in flight, and their late rejections are handled
 * here.
 */
export class QbitClassificationReads {
  /** Every read and every wait for a slot runs under it. */
  readonly signal: AbortSignal
  /** The facts this classification may be served and keep, with a shared reader. */
  readonly facts: QbitFundingFactsView | undefined
  readonly limiter: QbitReadLimiter
  private readonly controller = new AbortController()
  private readonly reads = new Map<string, QbitClassificationRead>()
  private failure: { error: unknown } | undefined
  private readonly failed: Promise<never>
  private fail: (error: unknown) => void = () => undefined
  private readonly release: () => void

  constructor(
    private readonly client: QbitClassifyTxClient,
    shared: QbitFundingTxReads | undefined,
    callerSignal: AbortSignal | undefined
  ) {
    this.signal = this.controller.signal
    this.limiter = shared ? shared.limiter(client) : new QbitReadLimiter()
    this.facts = shared?.begin(client)
    this.failed = new Promise<never>((_, reject) => {
      this.fail = reject
    })
    // Nobody may be waiting for it when the caller gives up after the end.
    this.failed.catch(() => undefined)
    const onCallerAbort = (): void => this.stop(callerSignal?.reason)
    if (callerSignal?.aborted) onCallerAbort()
    else callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    this.release = (): void => callerSignal?.removeEventListener('abort', onCallerAbort)
  }

  /** Whether it has stopped: the caller gave up, or a read or check failed. */
  get stopped(): boolean {
    return this.failure !== undefined
  }

  /**
   * The transaction `txid` (lower case), read once by this classification
   * however many outputs or walks need it, through the limiter. `forFacts`
   * marks it as read for its facts (the transaction's own outputs), which
   * other classifications through the same shared reader wait for rather
   * than read too (`fetchingElsewhere`). A read for its facts that joined a
   * read an ancestor's walk started, and saw it fail, reads the transaction
   * afresh once for itself, as it would have had the walk not come first;
   * any other read shares the one outcome, a failure included.
   */
  tx(txid: string, forFacts = false): Promise<EsploraTx> {
    const known = this.reads.get(txid)
    if (!known) return this.start(txid, forFacts).read
    if (!forFacts || known.forFacts) return known.read
    if (!known.joined) {
      known.joined = known.read.catch(error => {
        // A stopped classification reads nothing more.
        if (this.stopped) throw error
        return this.start(txid, true).read
      })
      known.joined.catch(() => undefined)
    }
    return known.joined
  }

  /** Read `txid` through the limiter, as the read every later `tx(txid)` shares. */
  private start(txid: string, forFacts: boolean): QbitClassificationRead {
    const done = forFacts ? this.facts?.fetch(txid) : undefined
    const read = this.limiter.run(
      () => this.client.getTx(txid, { signal: this.signal }),
      this.signal
    )
    if (done) read.then(done, done)
    // Its reader hears the failure; a read the classification no longer
    // waits for fails unheard.
    read.catch(() => undefined)
    const entry = { read, forFacts }
    this.reads.set(txid, entry)
    return entry
  }

  /**
   * Let go of the read of `txid`, so that a later `tx(txid)` reads it again:
   * once nothing in this classification needs it, or after it failed for a
   * caller that does not fail with it (an ancestor's walk). With `read`, only
   * while that read is still the one kept: the fresh read a read for the
   * transaction's own outputs started in its place stays shared.
   */
  forget(txid: string, read?: Promise<EsploraTx>): void {
    if (read === undefined || this.reads.get(txid)?.read === read) this.reads.delete(txid)
  }

  /** Stop with `error` unless already stopped: no read starts any more, and those in flight are cancelled. */
  stop(error: unknown): void {
    if (this.failure) return
    this.failure = { error }
    this.fail(error)
    this.controller.abort(error)
  }

  /**
   * Run `work` on `workers` workers until every one has returned, or reject at
   * once with the error the classification stopped with. A worker's own
   * failure stops it.
   */
  async run(workers: number, work: () => Promise<void>): Promise<void> {
    if (this.failure) throw this.failure.error
    const running = Array.from({ length: workers }, () =>
      Promise.resolve()
        .then(work)
        .catch(error => this.stop(error))
    )
    await Promise.race([Promise.all(running), this.failed])
    // Stopped in the same turn the last worker returned.
    const failure = this.failure as { error: unknown } | undefined
    if (failure) throw failure.error
  }

  /** Release the caller's signal; reads still in flight keep their own. */
  close(): void {
    this.release()
  }
}
