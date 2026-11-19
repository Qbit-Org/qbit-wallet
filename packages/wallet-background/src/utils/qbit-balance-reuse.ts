import type { UTXO } from '@qbit/wallet-shared'

/**
 * The fewest outputs a balance read's listing must hold for its answer to be
 * kept for reuse (`QbitBalanceReuse`). The explorer lists about 250 bytes an
 * output (measured: 5.2 MB for an account of about 20,700), so a listing of
 * 1,000 is about 250 KB a poll. Below that the poll is left as it was, in
 * every request and its timing: nothing is kept, so nothing waits.
 */
export const QBIT_BALANCE_REUSE_MIN_OUTPUTS = 1_000

/**
 * The longest a kept answer is reused, from when the read that confirmed it
 * began, by the monotonic clock and by the wall clock alike: the monotonic
 * clock can stand still while the system sleeps, and the wall clock can be
 * set back or forward, so the answer is too old once either reads past this
 * or runs backwards. Past it a poll reads the listing in full whatever the
 * statistics say, and that read, if it lists the same outputs under the
 * same statistics, confirms the answer again.
 */
export const QBIT_BALANCE_REUSE_MAX_AGE_MS = 5 * 60_000

/**
 * How long a poll with an answer to reuse waits for the tip once its
 * statistics have answered. A read of the listing needs the tip only for a
 * young coinbase output's maturity, where reuse always needs it: without
 * this bound a tip that hangs would hold every such poll to its deadline, to
 * answer with the split unknown, where a poll without an answer to reuse
 * answers in full. Past it, or once the tip fails, the poll reads the
 * listing as a poll without an answer to reuse does, the tip read handed on,
 * and sets the answer aside (`QbitBalanceReuseView.setAside`): until its age
 * runs out, polls of the address read as with nothing kept, so a slow or
 * broken tip costs one late poll in `QBIT_BALANCE_REUSE_MAX_AGE_MS` at most.
 * A poll whose tip answers within it still reuses.
 *
 * A poll with an answer to reuse that reads the listing after all is later
 * than one without by at most this and the time its listing takes (a round
 * trip, or its ride-out when the explorer answers it with a server error),
 * asked for only once the statistics have answered: a poll without asks for
 * its listing with the statistics, but it too classifies only once they
 * have answered, so their round trip or ride-out (no attempt begins more
 * than `QBIT_BALANCE_READ_RIDE_OUT_MS`, 3 s, after the first) delays both
 * alike. It is later also by the time its read of the send guard's
 * reservations takes when the answer stops being reusable during that read
 * (its age runs out, a clear, another read replaces it, a kept fact changes
 * or goes): the listing is asked for only then. In the controller
 * that read waits at most `qbitBalanceGuardWaitMs` (1 s) for the recent
 * spenders to probe, `qbitRecentSpendProbeWaitMs` (2 s) for the probes,
 * both begun with the read, and `qbitBalanceGuardWaitMs` for the guard: 4 s.
 */
export const QBIT_BALANCE_REUSE_TIP_WAIT_MS = 1_000

/**
 * The addresses per API client whose answers are kept, the most recently
 * kept or reused: the account shown and the one shown before it, so that a
 * switch back finds its answer. An answer of 20,000 outputs takes a few MB.
 */
const QBIT_BALANCE_REUSE_ADDRESSES_PER_CLIENT = 2

/** An output a kept answer counts, with what the balance split reads of it. */
export type QbitKeptBalanceOutput = Pick<UTXO, 'txid' | 'vout' | 'satoshis' | 'scriptPk'>

/**
 * What a complete balance read of an address found (`getQbitSpendableBalanceV2`):
 * its listing classified, every output confirmed, before any reservation.
 * The split is worked out again from it on each reuse, with that poll's
 * statistics and reservations, as the read worked it out.
 */
export interface QbitKeptBalance {
  /** The address statistics the read was made under (`qbitStatsSnapshot`), no mempool number above 0. */
  readonly stats: string
  /**
   * How many times the kept facts of the read's client had changed or gone
   * when it began, or when it asked for the listing after giving up a reuse
   * (`QbitFundingTxReads.factChanges`), and still had when it was kept: the
   * facts it was classified from. Undefined for a read without a shared
   * reader.
   */
  readonly facts: number | undefined
  /** The tip the read was made at. */
  readonly tipHeight: number
  /** With immature outputs: the lowest tip height at which one of them matures. */
  readonly matureAt?: number
  /** The outputs it found spendable. */
  readonly spendable: readonly QbitKeptBalanceOutput[]
  /** The coinbase outputs it found immature. */
  readonly immature: readonly QbitKeptBalanceOutput[]
}

/** What a complete balance read may keep: its answer, and the digest of the listing it read. */
export interface QbitKeptListing {
  readonly answer: QbitKeptBalance
  /** A SHA-256 of the listing's outputs (`txid:vout`, value and height of each), in any order. */
  readonly listingDigest: string
}

/** A kept answer a read may reuse (`QbitBalanceReuseView.reusable`). */
export interface QbitReusableBalance {
  readonly answer: QbitKeptBalance
}

/**
 * The kept answers as one balance read sees them (`QbitBalanceReuse.begin`):
 * it reuses and keeps answers only until the next `clear`, and only while
 * the store is usable. `facts` is the count of changes to the kept facts of
 * the read's client now (`QbitFundingTxReads.factChanges`), undefined
 * without a shared reader.
 */
export interface QbitBalanceReuseView {
  /**
   * The answer kept for `address` through `client` that this read may
   * reuse: confirmed, not too old (`QBIT_BALANCE_REUSE_MAX_AGE_MS`), not set
   * aside, and classified from facts none of which has changed or gone since
   * (its `facts` are `facts`); one that was is forgotten. It counts as used
   * only once the read reuses it (`used`).
   */
  reusable(
    client: object,
    address: string,
    facts: number | undefined
  ): QbitReusableBalance | undefined
  /**
   * Whether an answer is kept for `address` through `client` that a listing
   * this read asks for now could confirm, one not set aside: such a listing
   * is asked for fresh, as only one asked for fresh may confirm (see `keep`).
   */
  has(client: object, address: string): boolean
  /**
   * Whether `kept`, which `reusable` gave this read, may still be reused
   * now: it is still the answer kept for its address, not too old, neither a
   * clear since this read began nor a lock has come between, and no kept
   * fact has changed or gone since it was classified (`facts`); one whose
   * facts did is forgotten.
   */
  stillReusable(kept: QbitReusableBalance, facts: number | undefined): boolean
  /** Count `kept` as the most recently used of its client's answers: this read reuses it. */
  used(kept: QbitReusableBalance): void
  /**
   * Forget `kept`, if it is still the answer kept for its address: this
   * read found it no longer applies, so the next read asks for the listing
   * with the statistics again.
   */
  forget(kept: QbitReusableBalance): void
  /**
   * Set `kept` aside, if it is still the answer kept for its address: this
   * read could not reuse it for want of the tip, and reads the listing.
   * Until its age runs out, reads of its address neither reuse it nor ask
   * for a listing fresh, and keep, confirm and forget nothing (`keep`): they
   * read as with nothing kept.
   */
  setAside(kept: QbitReusableBalance): void
  /**
   * Keep what this read found, unless the answer kept for the address was
   * kept after this read began, by a later read or one it overlapped (this
   * read's listing may predate that one's), or is set aside: then it is
   * left as it is. Only otherwise is `found` called, for this read's answer
   * and its listing's digest, or undefined when its listing may not be kept,
   * which forgets the kept answer. When that one was kept under the same
   * statistics and facts with the same listing, and this read's listing was
   * asked for `fresh`, this read confirms it, and its own answer may be
   * reused from now on. Any other answer it keeps is only a candidate, for a
   * later read to confirm.
   */
  keep(
    client: object,
    address: string,
    fresh: boolean,
    found: () => QbitKeptListing | undefined
  ): void
}

export interface QbitBalanceReuseOptions {
  /**
   * Whether answers may be reused or kept right now; the controller passes
   * whether the wallet reads unlocked. While it is false neither happens.
   */
  usable?: () => boolean
  /** A clock in ms that does not run backwards: `performance.now` by default. */
  now?: () => number
  /** The wall clock in ms: `Date.now` by default. */
  wallNow?: () => number
}

/** When, by both clocks, a read began. */
interface QbitReuseTime {
  readonly monotonic: number
  readonly wall: number
}

interface QbitKeptEntry {
  readonly answer: QbitKeptBalance
  readonly listingDigest: string
  /** The latest place taken when it was kept: a read placed after it began after it was kept. */
  readonly keptAt: number
  /** When the read that confirmed it began; undefined while it is a candidate. */
  readonly confirmedAt: QbitReuseTime | undefined
  /** Set aside (`QbitBalanceReuseView.setAside`) until its age runs out. */
  setAside: boolean
}

/** Where an answer `reusable` gave a read was kept, and the entry it was. */
interface QbitGivenAnswer {
  readonly client: object
  readonly address: string
  readonly entry: QbitKeptEntry
}

/**
 * The balance answers of large accounts kept for reuse, per API client and
 * address, so that a poll of an unchanged account reads its statistics and
 * the tip, and no listing (see `getQbitSpendableBalanceV2`).
 *
 * The first complete answer under a set of statistics is only a candidate;
 * a later read, begun after it was kept, that lists the same outputs
 * (`txid:vout`, value and height of each) under the same statistics, in a
 * listing asked for fresh, confirms it, and that read's own answer is the
 * one reused. The explorer's statistics and its listing are separate index
 * views, either of which can lag the other, and a cache in front of it can
 * hand out one reply for 10 s, so neither one listing nor one reply handed
 * out twice is believed alone: a fresh read goes out under a URL no other
 * request has used, which no cache can answer, and never joins a request
 * already in flight. A poll that reuses an answer reads the statistics it
 * rests on fresh too.
 *
 * An answer holds only while the facts of funding transactions it was
 * classified from stand: each records how many times the kept facts of its
 * client had changed or gone when its read began, or when a poll that gave
 * up a reuse asked for the listing after all, before it classified anything
 * (`QbitFundingTxReads.factChanges`: a fact replaced by one that differs,
 * pushed out, forgotten, or every fact cleared), is kept only if that count
 * did not move before the read ended, and is confirmed and reused only while
 * it has not moved since; the count never goes back. Nor is an answer kept
 * in which an output was classified from an answer naming another script
 * than the address's: the reader keeps no such fact, so the right one, kept
 * later, would replace nothing and move no count. So a read of outputs that
 * corrects a fact, as a send's read does when the explorer answered a young
 * reward's transaction wrongly before, ends the reuse at once, whether it
 * then completes or fails, and so does a fact pushed out of the reader
 * before such a read keeps the right one anew; a read that changes nothing
 * leaves it.
 *
 * Should the tip fail, or not answer within `QBIT_BALANCE_REUSE_TIP_WAIT_MS`
 * of the statistics, on a poll with an answer to reuse, the answer is set
 * aside until its age runs out, and the address is read as with nothing
 * kept meanwhile; a listing read with no tip height, which cannot be kept,
 * forgets what is kept.
 *
 * The residuals: a listing that lags while its count and sum still equal
 * the statistics, repeated identically by two fresh reads, cannot be told
 * apart, and is reused for at most `QBIT_BALANCE_REUSE_MAX_AGE_MS` or until
 * the statistics change. So is a listing that changed under the same
 * statistics, as when a reorganisation at the same height swaps a payment
 * for another of the same value.
 *
 * Kept in memory only, for `QBIT_BALANCE_REUSE_ADDRESSES_PER_CLIENT`
 * addresses per client; clients are held weakly. An answer a read finds no
 * longer applies is forgotten (`QbitBalanceReuseView.forget`, `keep`);
 * `clear` forgets them all, and a read that began before it keeps and
 * reuses nothing. Each read takes its place (`begin`) when it is asked for,
 * before any await.
 */
export class QbitBalanceReuse {
  private answers = new WeakMap<object, Map<string, QbitKeptEntry>>()
  /** What each answer `reusable` handed out stands for. */
  private readonly given = new WeakMap<QbitReusableBalance, QbitGivenAnswer>()
  private started = 0
  /** The last read begun before the latest `clear`. */
  private cleared = 0
  private readonly usable: () => boolean
  private readonly now: () => number
  private readonly wallNow: () => number

  constructor(options: QbitBalanceReuseOptions = {}) {
    this.usable = options.usable ?? ((): boolean => true)
    this.now = options.now ?? ((): number => performance.now())
    this.wallNow = options.wallNow ?? ((): number => Date.now())
  }

  /** The place of a balance read beginning now, before its first await. */
  begin(): QbitBalanceReuseView {
    const order = ++this.started
    const beganAt: QbitReuseTime = { monotonic: this.now(), wall: this.wallNow() }
    const open = (): boolean => order > this.cleared && this.usable()
    // The entry behind `kept`, while it is still the one kept for its address.
    const current = (kept: QbitReusableBalance): QbitGivenAnswer | undefined => {
      const given = this.given.get(kept)
      if (!given) return undefined
      return this.answers.get(given.client)?.get(given.address) === given.entry ? given : undefined
    }
    return {
      reusable: (client, address, facts): QbitReusableBalance | undefined => {
        if (!open()) return undefined
        const scoped = this.answers.get(client)
        const entry = scoped?.get(address)
        if (!entry || this.isSetAside(entry) || !this.fresh(entry)) return undefined
        // A kept fact changed or went since it was classified: it no longer applies.
        if (entry.answer.facts !== facts) {
          scoped?.delete(address)
          return undefined
        }
        const kept: QbitReusableBalance = { answer: entry.answer }
        this.given.set(kept, { client, address, entry })
        return kept
      },
      has: (client, address): boolean => {
        const entry = open() ? this.answers.get(client)?.get(address) : undefined
        return entry !== undefined && !this.isSetAside(entry)
      },
      stillReusable: (kept, facts): boolean => {
        const given = current(kept)
        if (!open() || !given || !this.fresh(given.entry)) return false
        if (given.entry.answer.facts === facts) return true
        this.answers.get(given.client)?.delete(given.address)
        return false
      },
      used: (kept): void => {
        const given = current(kept)
        const scoped = given && this.answers.get(given.client)
        if (!given || !scoped) return
        // Last in the map's order is the most recently used.
        scoped.delete(given.address)
        scoped.set(given.address, given.entry)
      },
      forget: (kept): void => {
        const given = current(kept)
        if (given) this.answers.get(given.client)?.delete(given.address)
      },
      setAside: (kept): void => {
        const given = current(kept)
        if (given) given.entry.setAside = true
      },
      keep: (client, address, fresh, found): void => {
        if (!open()) return
        let scoped = this.answers.get(client)
        const kept = scoped?.get(address)
        // Kept after this read began (by a later read, or one this read
        // overlapped, whose listing may have been the same reply): this
        // read is no evidence for or against it. Set aside: nothing is
        // kept, confirmed or forgotten until its age runs out.
        if (kept && (order <= kept.keptAt || this.isSetAside(kept))) return
        const listing = found()
        if (!listing) {
          // A listing that may not be kept: what was kept no longer applies.
          scoped?.delete(address)
          return
        }
        const same =
          kept !== undefined &&
          kept.answer.stats === listing.answer.stats &&
          kept.answer.facts === listing.answer.facts &&
          kept.listingDigest === listing.listingDigest
        // Only a listing asked for fresh confirms. A read asks for one that
        // is not only while nothing is kept for the address or what is kept
        // is set aside; this is reached only when the answer set aside
        // reached its age while the read ran, and it is left as it is.
        if (same && !fresh) return
        if (!scoped) {
          scoped = new Map()
          this.answers.set(client, scoped)
        }
        scoped.delete(address)
        scoped.set(address, {
          answer: listing.answer,
          listingDigest: listing.listingDigest,
          keptAt: this.started,
          confirmedAt: same ? beganAt : undefined,
          setAside: false,
        })
        for (const oldest of scoped.keys()) {
          if (scoped.size <= QBIT_BALANCE_REUSE_ADDRESSES_PER_CLIENT) break
          scoped.delete(oldest)
        }
      },
    }
  }

  /** Forget every answer; reads begun before this keep and reuse nothing. */
  clear(): void {
    this.answers = new WeakMap()
    this.cleared = this.started
  }

  /**
   * A hook for tests, which no read calls: whether an answer is kept for
   * `address` through `client`, whatever it is (a candidate, confirmed,
   * past its age or set aside), so that a test can tell that a `clear` left
   * none in memory.
   */
  holds(client: object, address: string): boolean {
    return this.answers.get(client)?.has(address) === true
  }

  /**
   * Whether `entry` is confirmed, and not too old by either clock: a clock
   * that reads before its confirmation reads as too old.
   */
  private fresh(entry: QbitKeptEntry): boolean {
    const confirmedAt = entry.confirmedAt
    if (!confirmedAt) return false
    const ages = [this.now() - confirmedAt.monotonic, this.wallNow() - confirmedAt.wall]
    return ages.every(age => age >= 0 && age <= QBIT_BALANCE_REUSE_MAX_AGE_MS)
  }

  /** Whether `entry` is set aside still: its age has not run out. */
  private isSetAside(entry: QbitKeptEntry): boolean {
    return entry.setAside && this.fresh(entry)
  }
}
