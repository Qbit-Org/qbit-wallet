import { QbitApiError, type EsploraTx, type RequestOptions } from '@qbit-oss/api'

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
 * `QbitFundingTxReads`). A lookup, the listing or the tip whose reply's
 * body could not be read is made again, and for the one read that waits out
 * the explorer's server errors, one it answered with such an error
 * (`withQbitReadRetries`).
 */

/**
 * The most classification reads one explorer client has in flight at a time,
 * funding transactions and ancestors together, whatever its classifications:
 * the 256 requests the explorer's connection carries at once (its HTTP/2
 * settings allow 256 concurrent streams), as many as 1.0.9 put on it.
 * Measured in Chromium on the store builds from each request's send time,
 * 209 to 314 of 1.0.9's lookups were on the wire at once, up to 256 on its
 * main HTTP/3 connection, and every one was answered; it sends exactly 256 at
 * once for a mid-sized account. A classification reads that many at a time
 * for its first `QBIT_CLASSIFY_BURST_LOOKUPS` lookups, its burst, and
 * `QBIT_CLASSIFY_SUSTAINED_READS_IN_FLIGHT` at a time after them.
 *
 * Not more: past that, a read only waits in the browser with its time budget
 * already running (`createQbitExplorerFetch` arms its timers before the
 * request goes out), and the statistics, listing, tip and broadcast requests
 * wait behind it. 1.0.9, which read every output at once, failed at about
 * 14,000 to 20,000 in flight with `net::ERR_INSUFFICIENT_RESOURCES`. Over
 * HTTP/1.1 (the local regtest explorer), the six connections a browser
 * opens to one host carry the 256 in turn, 42 or 43 each, so the last is
 * sent only once the 42 replies ahead of it on its connection have come
 * back: should they take more than about 360 ms each, 15 s in all, it times
 * out before it is sent. The client then reads it again, as it retries any
 * read that timed out, and a reply whose body is cut off is read again by
 * `withQbitReadRetries`.
 *
 * Not fewer: 1.0.9 reads a mid-sized account in two waves, where 96 at a
 * time takes five or more. With 96, over eight cold runs a build for an
 * account of 466 to 620 outputs at about 100 ms a request, the first balance
 * read took a median 981 ms, where 1.0.9 took 737 ms, and the first Send-path
 * read 1,012 ms, where 1.0.9 took 649 ms; at about 20 ms a request the two
 * were level. At 256, over 35 interleaved cold sessions for an account of
 * about 510 outputs, the reads were level with 1.0.9 or faster, the first
 * balance read at about 100 ms a request excepted: a median 877 ms where
 * 1.0.9 took 769 ms, the ranges overlapping.
 */
export const QBIT_CLASSIFY_MAX_READS_IN_FLIGHT = 256

/**
 * The transaction lookups a classification starts at up to the full bound
 * (`QBIT_CLASSIFY_MAX_READS_IN_FLIGHT`) before it holds its reads to
 * `QBIT_CLASSIFY_SUSTAINED_READS_IN_FLIGHT`: its burst, as 1.0.9 reads.
 * Counted as lookups started, funding transactions and ancestors alike,
 * each once however often it is made again; outputs served from kept facts
 * or from the history, or classified from the listing alone, cost none, so
 * one lookup more than a burst takes one lookup's time more.
 *
 * What is known of 1.0.9: it was measured reading an account of 620
 * outputs about 256 at once; one user's account of 3,908 outputs is
 * reported not to load in it, which no build here has reproduced; and in
 * Chromium it failed outright with 20,000 lookups at once. 4,096 is chosen
 * so that accounts in the range 1.0.9 is known or likely to read stay
 * within the burst, read as fast as it read them. An account needing more
 * lookups than that which 1.0.9 could still read on a fast link, if there
 * is one, is slower past the burst. The explorer's bursts of 502s, measured
 * on reads held at about 1,000 lookups a second (96 in flight), began 7 to
 * 12 s into the read, later than 4,096 lookups take; held at 256, one of
 * five reads of 21,145 lookups met its first 502 at lookup 4,141, and
 * across 35 cold sessions of about 510 lookups at 256 none met one. The
 * lookups in flight when the burst is spent end as they would have, and
 * the classification's reads fall to the sustained rate as they do.
 */
export const QBIT_CLASSIFY_BURST_LOOKUPS = 4_096

/**
 * The reads a classification keeps in flight once it has spent its burst
 * (`QBIT_CLASSIFY_BURST_LOOKUPS`). At 96, about 1,000 lookups a second,
 * three of six cold Send-path reads of that large account, 21,158 outputs,
 * completed in 17.8 to 23.4 s; the other three failed, and so did the three
 * calls made again at once. Every failure was Cloudflare's HTTP 502 page,
 * sent with `Retry-After: 60`, over HTTP/2. The 502s came in bursts of 2
 * to 6 s, beginning 7 to 12 s into the read, of 211 to 319 replies each,
 * which hit 100 to 220 lookups. Read again after 500 ms and then 1,500 ms,
 * 560 of the 1,379 such replies became answers, and one read was carried
 * through a 3 s burst; but a lookup that met a 502 on all three attempts,
 * about 2 s, failed the read, and one call failed on a 502 for the tip,
 * which was not read again. Earlier runs met no 502 at 16 in flight (about
 * 450 lookups a second, 45.8 s) or at 64 (about 750 a second, 27.6 s); at
 * 256, two of five failed. So the rate held for about ten seconds looks like
 * what sets the bursts off, though that is unproven, and 32 stays below the
 * rates that met none. At 32, four of four cold Send-path reads of 21,700
 * lookups in Chromium completed, in 28 to 48 s, and met no server error.
 * The rate is a classification's own: two long ones through one client keep
 * 32 each in flight once past their bursts, 64 together, within the
 * limiter's bound.
 */
export const QBIT_CLASSIFY_SUSTAINED_READS_IN_FLIGHT = 32

/**
 * The most outputs `QbitFundingTxReads` keeps the facts of by default: an
 * address at the explorer's 50,000-output listing limit fits. Each takes the
 * txid key, one small record and a map slot (scripts are shared), and each
 * transaction's first record two links more: measured in Node 22 as the heap
 * kept for 65,536 single-output transactions whose txids nothing else held,
 * about 220 bytes, and about 255 once polls had forgotten and replaced some
 * or pushed some out, so 14 to 17 MB when full.
 */
export const QBIT_FUNDING_FACTS_MAX_OUTPOINTS = 65_536

/**
 * Distinct output scripts kept for sharing between facts. An address's
 * outputs all carry its one script, so this is only a bound against an
 * explorer that answers with a new script every time.
 */
const QBIT_FUNDING_FACTS_SHARED_SCRIPTS = 256

/**
 * The most outputs of one transaction whose facts are kept as a list alone,
 * looked through output by output. A transaction that pays the address
 * more, as one standard transaction can about 9,200 times, gets an index of
 * them by output number besides, so that serving, keeping or finding each
 * of its outputs takes the same time however many it pays: through the
 * list alone, serving all of them would take time growing with their
 * square. Transactions of one output, the usual case, get none.
 */
const QBIT_FUNDING_FACTS_LISTED_OUTPUTS = 16

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

/**
 * The facts kept for one transaction: a list of its outputs', usually one
 * long, from the node of the first output kept (`QbitFundingFactsHead`), each
 * later one's going in just after it. Facts kept again for an output replace
 * its node's in place.
 */
interface QbitFundingFactsNode {
  readonly vout: number
  value: number
  script: string
  coinbase: boolean
  next: QbitFundingFactsNode | undefined
}

/**
 * The first node of a transaction's list, which stays first for as long as the
 * transaction is kept, with the transaction's place in the order of use (see
 * `QbitFundingTxReads`): the keys of the transactions used just before and
 * just after it, the very strings the facts are kept by, so a place costs two
 * references and no copy of a key. Only this node has them: a transaction of
 * many outputs has one place.
 */
interface QbitFundingFactsHead extends QbitFundingFactsNode {
  /** The transaction used just before this one; none for the least recently used. */
  older: string | undefined
  /** The transaction used just after this one; none for the most recently used. */
  newer: string | undefined
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
 * `maxOutpoints` of them, the least recently used going first. The balance
 * read needs none for an output a coinbase maturity deep, which it
 * classifies from the listing alone, and keeps none of it, so the first read
 * of outputs for a send reads those itself. A balance read with more outputs
 * than that still to read one by one reads none of them
 * (`getQbitSpendableBalanceV2`): each of its polls would push out the facts
 * the next needs, read without end and never finish. A read of outputs for a
 * send, sweep or plan still reads every one. A classification counts
 * every kept output of its listing used before it reads any afresh, so what
 * it then keeps pushes out other addresses' facts before its own: a listing
 * that fits is read again only where its facts were pushed out, as after a
 * switch to another account and back. `clear`
 * forgets them all, and a read that began before it keeps nothing after it
 * and is served nothing more, whether its listing, its statistics, its walk
 * of the history or its classification was running: each read begins its
 * view (`begin`) before its first request and classifies through it, and a
 * caller that awaits anything of its own first takes that place when it is
 * asked for the read (`begin`'s `since`). The
 * limiters are kept: reads already in flight still hold their slots, and a
 * read begun before a clear still completes, reading every transaction.
 *
 * A transaction is used when its facts are kept, served or touched, and once
 * more than `maxOutpoints` outputs are kept, the least recently used
 * transactions go, each whole, until no more are. The order of use is a list
 * through the transactions' first nodes, each naming the transaction used
 * just before it and the one used just after (`QbitFundingFactsHead`): a use
 * moves a transaction to its new end, and the next to go is at its old end,
 * so pushing one out costs the same however many uses and drops came before.
 */
export class QbitFundingTxReads {
  readonly maxOutpoints: number
  readonly maxReadsInFlight: number
  private readonly usable: () => boolean
  private readonly limiters = new WeakMap<object, QbitReadLimiter>()
  private readonly scopes = new WeakMap<object, number>()
  private nextScope = 0
  /**
   * By `${scope}:${txid}`, each transaction's list from its first node. Their
   * order of use runs from `oldest` through each first node's `newer` to
   * `newest`; the map's own order means nothing.
   */
  private facts = new Map<string, QbitFundingFactsHead>()
  /** The key, as `facts` holds it, of the least recently used transaction: the next to go. */
  private oldest: string | undefined
  /** The key, as `facts` holds it, of the most recently used transaction. */
  private newest: string | undefined
  /**
   * The nodes of a transaction with more than
   * `QBIT_FUNDING_FACTS_LISTED_OUTPUTS` outputs kept, by output number, under
   * its key in `facts` for as long as it is there.
   */
  private indexes = new Map<string, Map<number, QbitFundingFactsNode>>()
  private outpoints = 0
  private scripts = new Map<string, string>()
  /** Fresh funding reads in flight, by `${scope}:${txid}`, and how many. */
  private fetching = new Map<string, number>()
  private started = 0
  /** The last classification begun before the latest `clear`. */
  private cleared = 0
  /** When each view this reader began was begun, by the view. */
  private readonly orders = new WeakMap<QbitFundingFactsView, number>()
  /**
   * How many times kept facts changed or went (`factChanges`), by client
   * scope, apart from clears; never reset. An array, as scopes are small
   * numbers: counting a drop looks nothing up in a map.
   */
  private readonly changes: number[] = []
  /** How many times `clear` dropped every fact (`factChanges`). */
  private clears = 0

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
   * How many times a fact kept for a transaction read through `client` has
   * changed or gone: replaced by one that differs (its value, its script
   * compared ignoring letter case, or whether it is a coinbase), dropped
   * (pushed out, or forgotten), or dropped with every other by a `clear`. It
   * only ever grows, so an answer worked out from the facts as they stood
   * holds only while this reads the same.
   */
  factChanges(client: object): number {
    const scope = this.scopes.get(client)
    return this.clears + (scope === undefined ? 0 : (this.changes[scope] ?? 0))
  }

  /** Count `kept`, kept for an output of `key`'s transaction, replaced by `facts`, if they differ. */
  private countReplaced(
    key: string,
    kept: QbitFundingFactsNode,
    facts: QbitFundingOutputFacts
  ): void {
    if (
      kept.value === facts.value &&
      (kept.script === facts.script || kept.script.toLowerCase() === facts.script.toLowerCase()) &&
      kept.coinbase === facts.coinbase
    ) {
      return
    }
    this.changed(key)
  }

  /** Count a change to the facts kept of `key`'s transaction (`factChanges`). */
  private changed(key: string): void {
    const scope = Number(key.slice(0, key.indexOf(':')))
    this.changes[scope] = (this.changes[scope] ?? 0) + 1
  }

  /**
   * The facts as one read beginning now through `client` sees them: it is
   * served and keeps facts only until the next `clear`, and only while
   * `usable()`. A read begins it before its first request, so a clear while
   * it lists the outputs or walks the history counts as well. With `since`,
   * a view this reader began when the read was asked for, before its caller's
   * own awaits, the read keeps that view's place among the clears, through
   * `client`: a clear after `since` was begun leaves it keeping and served
   * nothing. Only the place carries over, never what may be served or kept;
   * a view another reader began is refused.
   */
  begin(client: object, since?: QbitFundingFactsView): QbitFundingFactsView {
    let order: number
    if (since === undefined) {
      order = ++this.started
    } else {
      const begun = this.orders.get(since)
      if (begun === undefined) throw new Error('A view of funding facts another reader began')
      order = begun
    }
    let scope = this.scopes.get(client)
    if (scope === undefined) {
      scope = ++this.nextScope
      this.scopes.set(client, scope)
    }
    const prefix = `${scope}:`
    const open = (): boolean => order > this.cleared && this.usable()
    const view: QbitFundingFactsView = {
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
    this.orders.set(view, order)
    return view
  }

  /** Forget every fact; classifications begun before this keep nothing more and are served nothing. */
  clear(): void {
    this.facts = new Map()
    this.oldest = undefined
    this.newest = undefined
    this.indexes = new Map()
    this.outpoints = 0
    this.scripts = new Map()
    this.fetching = new Map()
    this.clears += 1
    this.cleared = this.started
  }

  private get<T extends { readonly vout: number }>(
    key: string,
    outputs: readonly T[]
  ): { output: T; facts: QbitFundingOutputFacts }[] | undefined {
    const head = this.facts.get(key)
    if (!head) return undefined
    const index = head.next ? this.indexOf(key, head) : undefined
    const found: { output: T; facts: QbitFundingOutputFacts }[] = []
    for (const output of outputs) {
      let node: QbitFundingFactsNode | undefined = head
      if (index) node = index.get(output.vout)
      else while (node && node.vout !== output.vout) node = node.next
      if (!node) return undefined
      found.push({
        output,
        facts: { coinbase: node.coinbase, value: node.value, script: node.script },
      })
    }
    this.used(head)
    return found
  }

  private has(key: string, vout: number): boolean {
    return this.nodeOf(key, this.facts.get(key), vout) !== undefined
  }

  /** The node of output `vout` in `key`'s list from `head`, through its index when it has one. */
  private nodeOf(
    key: string,
    head: QbitFundingFactsNode | undefined,
    vout: number
  ): QbitFundingFactsNode | undefined {
    const index = head?.next ? this.indexOf(key, head) : undefined
    if (index) return index.get(vout)
    let node = head
    while (node && node.vout !== vout) node = node.next
    return node
  }

  /**
   * The index of `key`'s list from `head`, which only a list longer than
   * `QBIT_FUNDING_FACTS_LISTED_OUTPUTS` has: a shorter one, the usual one of
   * a single output, is told so by a few steps along it, and no index is
   * looked up for it.
   */
  private indexOf(
    key: string,
    head: QbitFundingFactsNode
  ): Map<number, QbitFundingFactsNode> | undefined {
    let node: QbitFundingFactsNode | undefined = head
    for (let listed = 0; listed < QBIT_FUNDING_FACTS_LISTED_OUTPUTS; listed += 1) {
      node = node?.next
      if (!node) return undefined
    }
    return this.indexes.get(key)
  }

  private touch(key: string): void {
    const head = this.facts.get(key)
    if (head) this.used(head)
  }

  private keep(key: string, vout: number, facts: QbitFundingOutputFacts): boolean {
    const head = this.facts.get(key)
    // The latest checked facts of an output replace any kept before.
    const kept = this.nodeOf(key, head, vout)
    const script = this.shared(facts.script)
    if (kept) {
      this.countReplaced(key, kept, facts)
      kept.value = facts.value
      kept.script = script
      kept.coinbase = facts.coinbase
      this.used(head as QbitFundingFactsHead)
      return false
    }
    if (head) {
      // Just after the first node, which keeps the transaction's place.
      const node: QbitFundingFactsNode = {
        vout,
        value: facts.value,
        script,
        coinbase: facts.coinbase,
        next: head.next,
      }
      head.next = node
      this.used(head)
      this.indexAdded(key, head, node)
    } else {
      const first: QbitFundingFactsHead = {
        vout,
        value: facts.value,
        script,
        coinbase: facts.coinbase,
        next: undefined,
        older: undefined,
        newer: undefined,
      }
      this.facts.set(key, first)
      this.append(key, first)
    }
    this.outpoints += 1
    // Past the bound, the least recently used go, whole, each from the old
    // end of the order of use, so the transaction just kept goes last. Once
    // the order is empty nothing is left to go, whatever the count says.
    while (this.outpoints > this.maxOutpoints && this.oldest !== undefined) {
      const oldest = this.oldest
      this.drop(oldest, this.facts.get(oldest) as QbitFundingFactsHead)
    }
    return true
  }

  /**
   * Note `node`, just kept after `head` in `key`'s list, in the list's index,
   * which it gets once it holds more than `QBIT_FUNDING_FACTS_LISTED_OUTPUTS`.
   */
  private indexAdded(key: string, head: QbitFundingFactsHead, node: QbitFundingFactsNode): void {
    // Counted only as far as the bound: a shorter list, the usual one, has no
    // index to look up.
    let listed = 0
    let next: QbitFundingFactsNode | undefined = head
    while (next && listed <= QBIT_FUNDING_FACTS_LISTED_OUTPUTS) {
      listed += 1
      next = next.next
    }
    if (listed <= QBIT_FUNDING_FACTS_LISTED_OUTPUTS) return
    const index = this.indexes.get(key)
    if (index) {
      index.set(node.vout, node)
      return
    }
    // Past the bound only with this node.
    const built = new Map<number, QbitFundingFactsNode>()
    for (let each: QbitFundingFactsNode | undefined = head; each; each = each.next) {
      built.set(each.vout, each)
    }
    this.indexes.set(key, built)
  }

  private forget(key: string): void {
    const head = this.facts.get(key)
    if (head) this.drop(key, head)
  }

  /** Drop what is kept of `key`'s transaction, `head` its first node, whole. */
  private drop(key: string, head: QbitFundingFactsHead): void {
    this.unlink(head)
    this.facts.delete(key)
    this.outpoints -= this.dropped(key, head)
  }

  /**
   * Count the transaction of first node `head` used now: it moves to the new
   * end of the order of use.
   */
  private used(head: QbitFundingFactsHead): void {
    // The most recently used already.
    if (head.newer === undefined) return
    // Its key as `facts` holds it, which the transaction used just after it names.
    const key = (this.facts.get(head.newer) as QbitFundingFactsHead).older as string
    this.unlink(head)
    this.append(key, head)
  }

  /** Take the transaction of first node `head` out of the order of use. */
  private unlink(head: QbitFundingFactsHead): void {
    if (head.older === undefined) this.oldest = head.newer
    else (this.facts.get(head.older) as QbitFundingFactsHead).newer = head.newer
    if (head.newer === undefined) this.newest = head.older
    else (this.facts.get(head.newer) as QbitFundingFactsHead).older = head.older
  }

  /**
   * Put the transaction of first node `head` at the new end of the order of
   * use; `key` is the very string `facts` holds it by, so no other copy of it
   * is kept.
   */
  private append(key: string, head: QbitFundingFactsHead): void {
    head.older = this.newest
    head.newer = undefined
    if (this.newest === undefined) this.oldest = key
    else (this.facts.get(this.newest) as QbitFundingFactsHead).newer = key
    this.newest = key
  }

  /** How many outputs `key`'s list from `head` held, its index dropped with it. */
  private dropped(key: string, head: QbitFundingFactsNode): number {
    // An answer worked out from them may stand no more: as much a change as a replacement.
    this.changed(key)
    const index = this.indexOf(key, head)
    if (index) {
      this.indexes.delete(key)
      return index.size
    }
    let count = 0
    for (let node: QbitFundingFactsNode | undefined = head; node; node = node.next) count += 1
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

/**
 * The pause before each further attempt of a read whose reply's body could
 * not be read (`withQbitReadRetries`): two more attempts at most.
 */
export const QBIT_BODY_READ_RETRY_PAUSES_MS: readonly number[] = [100, 300]

/**
 * The pause before each further attempt of a read that rides out the
 * explorer's server errors (`withQbitReadRetries` given the statuses to ride
 * out), beyond the client's own attempts: four more at most, over about
 * 14 s, a lookup holding its slot through them, within
 * `QBIT_SERVER_ERROR_RIDE_OUT_MS`. Long enough to ride out the bursts of the
 * explorer's 502s seen at `QBIT_CLASSIFY_SUSTAINED_READS_IN_FLIGHT`, 2 to
 * 6 s each, which outlasted the 2 s that 500 ms and then 1,500 ms covered.
 * Only the Send screen's read of outputs asks for it
 * (`readQbitAddressUtxosRidingOut` in `qbit-api`): every other read fails
 * on a server error as fast as the client alone, as in 1.0.9.
 *
 * A known limit, kept so that the bound holds: a lookup pauses inside its
 * slot of the limiter, and keeps it until its last attempt ends. In a
 * burst of 502s during its first `QBIT_CLASSIFY_BURST_LOOKUPS` lookups, the
 * Send screen's read can hold up to 256 slots, each for about 14 s when the
 * explorer answers at once with a `Retry-After` past the client's cap, and
 * 18.5 s without one, with nothing on the wire between its attempts; where
 * the client itself waits on a `Retry-After` within its cap, or the replies
 * are slow, for up to two client calls (`QBIT_SERVER_ERROR_RIDE_OUT_MS`):
 * 20.5 s for a 503 with `Retry-After: 5`, 36.5 s with `Retry-After: 9`,
 * 38.3 s for 502s each answered 6 s late, and 60 s, one client call as in
 * 1.0.9, with `Retry-After: 30`. Every other read through the same client
 * waits behind it
 * meanwhile (a balance poll was measured to take 13.9 s); past its burst it
 * holds 32 at most. Reads that do not ride out server errors never pause on
 * one.
 */
export const QBIT_SERVER_ERROR_RETRY_PAUSES_MS: readonly number[] = [500, 1_500, 4_000, 8_000]

/**
 * How long a read rides out server errors: no further attempt begins once
 * this long has passed since its first began. It bounds when an attempt may
 * begin, not how long the last one runs, so a read fails within one client
 * call after it, about two client calls' time at most where each takes
 * nearly as long. For one lookup the explorer keeps answering, through
 * `@qbit-oss/api` 0.1.1 (two attempts more of its own, 300 ms and 600 ms
 * apart, or after a `Retry-After` of up to 30 s), with replies at once:
 * - a 502 whose `Retry-After` is past the client's cap, as the explorer's
 *   are: five requests, failing 14 s on, where 1.0.9 failed at once;
 * - a 500 (a lookup's), 502, 503 or 504 without one: 15 requests, 18.5 s,
 *   where 1.0.9 took three and 0.9 s;
 * - a 503 with `Retry-After: 5`: six requests, 20.5 s, where 1.0.9 took
 *   three and 10 s;
 * - a 503 with `Retry-After: 30`: three requests, 60 s, as 1.0.9: one call.
 * Where each client call takes long, as measured: a 503 with
 * `Retry-After: 9`, answered at once, the client waiting 9 s twice, six
 * requests, 36.5 s, against 18 s for the client alone; 502s without one,
 * each arriving 6 s after its request, 38.3 s against 18.9 s.
 */
export const QBIT_SERVER_ERROR_RIDE_OUT_MS = 20_000

/** The statuses `@qbit-oss/api` retries a read for by itself, its body unread included. */
const QBIT_API_RETRIED_STATUSES = new Set([429, 500, 502, 503, 504])

/**
 * The server errors a transaction lookup that rides them out is read again
 * after (`withQbitReadRetries`): those `@qbit-oss/api` takes for transient,
 * a 429 aside, whose `Retry-After` the client follows as before.
 */
export const QBIT_LOOKUP_RETRY_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504])

/**
 * The server errors the output listing of a read that rides them out is
 * read again after: not a bare 500, which can be the explorer refusing to
 * list an address past its limit (`qbitUtxoListRefusal`), and is judged as
 * before.
 */
export const QBIT_LISTING_RETRY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])

/**
 * The server errors the tip read of a classification that rides them out is
 * read again after (`withQbitReadRetries`): a 502, 503 or 504, as for the
 * listing. A bare 500 is the client's to retry, as before.
 */
export const QBIT_TIP_RETRY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])

/** Whether `error` is the client's failure to read the body of a reply whose headers arrived. */
function isQbitApiBodyReadError(error: QbitApiError): boolean {
  return (
    error.kind === 'parse' &&
    error.status !== undefined &&
    error.message.startsWith('failed to read response body from ')
  )
}

/**
 * Whether `error` is the explorer client's failure to read the body of a
 * reply whose headers had arrived, as when the connection is lost in the
 * middle of it, for a status the client does not retry by itself.
 * `@qbit-oss/api` reads every body before it hands a reply on, and reports
 * such a failure as a `parse` error with the reply's `status` and the
 * message "failed to read response body from …" (`bodyReadError`), which it
 * retries only for 429 and 5xx. The wallet's explorer fetch
 * (`createQbitExplorerFetch`) hands it the bytes that arrived, with the read's
 * own failure at their end, so it judges that the same. Every other `parse`
 * error, of a body that was read but is not JSON or fails the client's
 * checks, carries no status; a timeout, a reply over the size limit, an HTTP
 * error and an abort have kinds of their own. None of those is this.
 */
export function isQbitBodyReadFailure(error: unknown): boolean {
  return (
    QbitApiError.is(error) &&
    isQbitApiBodyReadError(error) &&
    error.status !== undefined &&
    !QBIT_API_RETRIED_STATUSES.has(error.status)
  )
}

/**
 * Whether `error` is the explorer client's answer to a read the explorer
 * replied to with one of `statuses`: its HTTP error (`http`), or a reply of
 * that status whose body could not be read. `@qbit-oss/api` retries such a
 * read twice by itself, 300 ms and then 600 ms apart, unless the reply's
 * `Retry-After` is past its cap (`maxRetryAfterMs`, 30 s), when it hands
 * the reply back at once: that is how a lookup ended on the explorer's 502
 * with no second request.
 */
export function isQbitServerError(error: unknown, statuses: ReadonlySet<number>): boolean {
  return (
    QbitApiError.is(error) &&
    error.status !== undefined &&
    statuses.has(error.status) &&
    (error.kind === 'http' || isQbitApiBodyReadError(error))
  )
}

/**
 * Whether a read that rides out server errors (`readQbitAddressUtxosRidingOut`
 * in `qbit-api`) would have made again the read that failed with `error`,
 * which names it by its `url`: a transaction lookup answered with one of
 * `QBIT_LOOKUP_RETRY_STATUSES`, or the output listing or the chain tip with
 * one of `QBIT_LISTING_RETRY_STATUSES` and `QBIT_TIP_RETRY_STATUSES`. Any
 * other failure, a bare 500 on the listing, the address statistics or a
 * page of its history among them, such a read meets the same way.
 */
export function isQbitRideOutFailure(error: unknown): boolean {
  if (!QbitApiError.is(error) || error.url === undefined) return false
  let path: string
  try {
    path = new URL(error.url).pathname
  } catch {
    return false
  }
  if (/\/tx\/[0-9a-f]{64}$/i.test(path)) {
    return isQbitServerError(error, QBIT_LOOKUP_RETRY_STATUSES)
  }
  if (/\/address\/[^/]+\/utxo$/.test(path)) {
    return isQbitServerError(error, QBIT_LISTING_RETRY_STATUSES)
  }
  if (/\/blocks\/tip\/height$/.test(path)) return isQbitServerError(error, QBIT_TIP_RETRY_STATUSES)
  return false
}

/**
 * `read()`, made again while it fails in a way the explorer may well not
 * repeat: with a body that could not be read (`isQbitBodyReadFailure`),
 * twice at most, after the pauses of `QBIT_BODY_READ_RETRY_PAUSES_MS`, which
 * the client does not retry by itself; and, given `rideOut`, with one of
 * those server errors (`isQbitServerError`), four times at most, after the
 * pauses of `QBIT_SERVER_ERROR_RETRY_PAUSES_MS`, while the next attempt
 * would begin within `QBIT_SERVER_ERROR_RIDE_OUT_MS` of the first. Without
 * it a server error is the read's at once, as the client handed it back.
 * Each pause is the one for the attempt that just failed, so a body lost on
 * the third attempt or later fails it. What it reads is an idempotent GET,
 * and one such reply among tens of thousands of lookups would otherwise
 * fail the whole read of the outputs. Once the attempts run out it fails
 * with the last one's error; any other failure is the read's at once. Once
 * `signal` aborts it makes no further attempt and ends a pause at once,
 * rejecting with the signal's reason; an attempt in flight ends under the
 * same signal.
 */
export async function withQbitReadRetries<T>(
  read: () => Promise<T>,
  signal: AbortSignal | undefined,
  rideOut?: ReadonlySet<number>
): Promise<T> {
  const began = Date.now()
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read()
    } catch (error) {
      const serverError = rideOut !== undefined && isQbitServerError(error, rideOut)
      const pauses = isQbitBodyReadFailure(error)
        ? QBIT_BODY_READ_RETRY_PAUSES_MS
        : serverError
          ? QBIT_SERVER_ERROR_RETRY_PAUSES_MS
          : undefined
      const pauseMs = pauses?.[attempt]
      if (pauseMs === undefined) throw error
      if (serverError && Date.now() + pauseMs - began >= QBIT_SERVER_ERROR_RIDE_OUT_MS) throw error
      await qbitPause(pauseMs, signal)
    }
  }
}

/**
 * A pause of `ms`, which rejects with `signal`'s reason at once if it has
 * aborted, and ends so as soon as it does.
 */
function qbitPause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
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
 * here. A read whose reply's body could not be read is made again in the
 * slot it holds (`withQbitReadRetries`), so the bound is unchanged; so, in a
 * classification that rides them out (`rideOut`, which only
 * `readQbitAddressUtxosRidingOut` in `qbit-api` sets), is a read of a
 * transaction for its own outputs that the explorer answered with a server
 * error (`QBIT_LOOKUP_RETRY_STATUSES`), pausing in that slot between its
 * attempts (see `QBIT_SERVER_ERROR_RETRY_PAUSES_MS`). Every other
 * classification leaves a server error to the client. A read fails, for the
 * rules of its caller, only once its attempts have.
 */
export class QbitClassificationReads {
  /** Every read and every wait for a slot runs under it. */
  readonly signal: AbortSignal
  /** The facts this classification may be served and keep, with a shared reader. */
  readonly facts: QbitFundingFactsView | undefined
  readonly limiter: QbitReadLimiter
  private readonly controller = new AbortController()
  private readonly reads = new Map<string, QbitClassificationRead>()
  /** Lookups started (`QBIT_CLASSIFY_BURST_LOOKUPS`), each once however often it is made again. */
  private lookups = 0
  /** Lookups started and not yet ended: waiting for a slot of the limiter or in flight. */
  private active = 0
  /** Lookups waiting, first come first served, for fewer than the sustained rate to be active. */
  private readonly held: { resolve: () => void; reject: (reason: unknown) => void }[] = []
  private failure: { error: unknown } | undefined
  private readonly failed: Promise<never>
  private fail: (error: unknown) => void = () => undefined
  private readonly release: () => void

  /**
   * `facts` is the view of `shared` the read this classification is part of
   * began before its first request (`QbitFundingTxReads.begin`), so a clear
   * since then leaves it keeping and served nothing; begun now when not given.
   * With `rideOut`, a lookup for a transaction's own outputs that the
   * explorer answers with a server error is made again
   * (`QBIT_LOOKUP_RETRY_STATUSES`). An ancestor's walk reads its transaction
   * again only after a lost body, whatever `rideOut` says: the walk takes its
   * failure for an output that is not the account's own change, as 1.0.9
   * did after the client's own attempts, and a balance read must not wait
   * out an ancestor the explorer keeps failing. A walk that joins a read for
   * the transaction's own outputs shares how that one is made. Only the
   * check of a send plan's inputs (`checkQbitSpendInputs`), for which a
   * failed ancestor is an unknown outcome and not someone else's change,
   * also rides them out for its walks (`rideOutWalks`, with `rideOut`).
   */
  constructor(
    private readonly client: QbitClassifyTxClient,
    shared: QbitFundingTxReads | undefined,
    callerSignal: AbortSignal | undefined,
    facts?: QbitFundingFactsView,
    private readonly rideOut = false,
    private readonly rideOutWalks = false
  ) {
    this.signal = this.controller.signal
    this.signal.addEventListener(
      'abort',
      () => {
        for (const waiter of this.held.splice(0)) waiter.reject(this.signal.reason)
      },
      { once: true }
    )
    this.limiter = shared ? shared.limiter(client) : new QbitReadLimiter()
    this.facts = shared ? (facts ?? shared.begin(client)) : undefined
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

  /**
   * Read `txid` through the limiter, as the read every later `tx(txid)`
   * shares, once this classification may start another lookup (`admit`).
   */
  private start(txid: string, forFacts: boolean): QbitClassificationRead {
    const done = forFacts ? this.facts?.fetch(txid) : undefined
    const lookup = (): Promise<EsploraTx> => {
      const limited = this.limiter.run(
        () =>
          withQbitReadRetries(
            () => this.client.getTx(txid, { signal: this.signal }),
            this.signal,
            this.rideOut && (forFacts || this.rideOutWalks) ? QBIT_LOOKUP_RETRY_STATUSES : undefined
          ),
        this.signal
      )
      limited.then(this.ended, this.ended)
      return limited
    }
    const turn = this.admit()
    const read = turn ? turn.then(lookup) : lookup()
    if (done) read.then(done, done)
    // Its reader hears the failure; a read the classification no longer
    // waits for fails unheard.
    read.catch(() => undefined)
    const entry = { read, forFacts }
    this.reads.set(txid, entry)
    return entry
  }

  /**
   * Undefined when another lookup may start at once: within the burst
   * (`QBIT_CLASSIFY_BURST_LOOKUPS`), or once that is spent, while fewer than
   * `QBIT_CLASSIFY_SUSTAINED_READS_IN_FLIGHT` of this classification's
   * lookups are active and none waits before it. Otherwise its turn, first
   * come first served, waited for with no slot of the limiter held; that
   * rejects with the signal's reason once the classification stops.
   */
  private admit(): Promise<void> | undefined {
    if (
      this.lookups < QBIT_CLASSIFY_BURST_LOOKUPS ||
      (this.held.length === 0 && this.active < QBIT_CLASSIFY_SUSTAINED_READS_IN_FLIGHT)
    ) {
      this.lookups += 1
      this.active += 1
      return undefined
    }
    if (this.signal.aborted) return Promise.reject(this.signal.reason)
    return new Promise<void>((resolve, reject) => {
      this.held.push({
        resolve: () => {
          this.lookups += 1
          this.active += 1
          resolve()
        },
        reject,
      })
    })
  }

  /** A lookup ended: those waiting start while fewer than the sustained rate are active. */
  private readonly ended = (): void => {
    this.active -= 1
    while (this.held.length > 0 && this.active < QBIT_CLASSIFY_SUSTAINED_READS_IN_FLIGHT) {
      this.held.shift()?.resolve()
    }
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
