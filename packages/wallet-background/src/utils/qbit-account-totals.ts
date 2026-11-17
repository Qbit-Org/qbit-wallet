import type { QbitAccountTotal } from '@qbit/wallet-shared'
import type { ChainType } from '@qbit/wallet-types'

import { QbitReadLimiter } from './qbit-funding-tx-reads'

/**
 * How long a measured total counts as fresh: an account switcher opened
 * again within it reads nothing. From when its answer arrived for a read of
 * its own, and from when the balance read that fed it began
 * (`QbitAccountTotals.measured`), since that read may settle long after its
 * statistics arrived.
 */
export const QBIT_ACCOUNT_TOTAL_FRESH_MS = 60_000

/**
 * After a failed read of an address, no new request for it this long: a
 * switcher reopened at once, or a page asking again, answers from what is
 * kept, with `error: true`, instead of asking an explorer that just failed.
 */
export const QBIT_ACCOUNT_TOTAL_RETRY_AFTER_MS = 10_000

/**
 * How long after the wallet submits a transaction through a client the
 * explorer's statistics may still lag it: its address index follows the
 * mempool on a loop, and a replica behind the same endpoint may follow
 * later. A total measured by a read that began within this time after its
 * client's latest invalidation (`QbitAccountTotals.invalidate`) is fresh
 * only for `QBIT_ACCOUNT_TOTAL_SETTLING_FRESH_MS`.
 */
export const QBIT_ACCOUNT_TOTAL_SETTLING_MS = 30_000

/**
 * How long a total measured while its client's explorer may still lag a
 * submission (`QBIT_ACCOUNT_TOTAL_SETTLING_MS`) counts as fresh, instead of
 * `QBIT_ACCOUNT_TOTAL_FRESH_MS`: a switcher reopened after it reads again.
 */
export const QBIT_ACCOUNT_TOTAL_SETTLING_FRESH_MS = 10_000

/**
 * Reads of account totals in flight per API client, first come first served
 * past it. A limiter of their own (`QbitReadLimiter`), not the one the
 * classification reads share: a switcher listing many accounts neither
 * waits behind a long read of outputs nor holds up the balance's. Fewer
 * than the six connections a browser opens to one host over HTTP/1.1 (the
 * loopback regtest node, a custom endpoint): the switcher's reads never
 * hold more than four of them, whatever else is in flight.
 */
export const QBIT_ACCOUNT_TOTALS_MAX_READS_IN_FLIGHT = 4

/**
 * One read's deadline: the explorer call, its retries and its backoff
 * included, which the client enforces (`RequestOptions.deadlineMs`). The
 * wait for a limiter slot is not part of it.
 */
export const QBIT_ACCOUNT_TOTAL_READ_DEADLINE_MS = 8_000

/** The most addresses one `getQbitAccountTotals` call takes. */
export const QBIT_ACCOUNT_TOTALS_MAX_ADDRESSES = 1_024

/**
 * What a read of a total hands the client: its deadline, the signal a clear
 * aborts, and `fresh`, so that the request goes out on its own, under a URL
 * no other request has used and past every HTTP cache, never answered by a
 * reply to a request made before the read began (`QbitTxOutspendsOptions`).
 */
export interface QbitAccountTotalReadOptions {
  deadlineMs: number
  signal: AbortSignal
  fresh: true
}

/** What `QbitAccountTotals` reads an address's total through: the SDK's statistics read. */
export interface QbitAccountTotalsClient {
  getAddressBalance(
    address: string,
    options: QbitAccountTotalReadOptions
  ): Promise<{ totalSats: number }>
}

export interface QbitAccountTotalsOptions {
  /** The clock, in ms since the epoch; `Date.now` by default. */
  now?: () => number
  /**
   * Whether totals may be served or kept right now; the controller passes
   * whether the wallet reads unlocked. While it is false every answer is the
   * no-total one and nothing a read settles with is kept.
   */
  usable?: () => boolean
  /** Reads in flight per client; `QBIT_ACCOUNT_TOTALS_MAX_READS_IN_FLIGHT` by default. */
  maxReadsInFlight?: number
  /** One read's deadline; `QBIT_ACCOUNT_TOTAL_READ_DEADLINE_MS` by default. */
  readDeadlineMs?: number
}

/**
 * A read's place (`QbitAccountTotals.begin`): its rank among the reads, the
 * clears and the invalidations, and the clock when it was taken.
 */
export interface QbitAccountTotalPlace {
  readonly order: number
  readonly at: number
}

/** What is kept of one address on one client. */
interface QbitKeptTotal {
  /** The last total measured, `null` while none was. */
  totalBalance: number | null
  /** When that total was measured (see `QBIT_ACCOUNT_TOTAL_FRESH_MS`); `null` with no total. */
  readAt: number | null
  /** The rank of the read that measured it; 0 with none. */
  measuredBy: number
  /** Whether it may predate a submission through its client: never fresh then. */
  stale: boolean
  /** How long after `readAt` it is fresh. */
  freshForMs: number
  /** The rank of the latest-begun read whose outcome is recorded; 0 with none. */
  outcomeOf: number
  /** Whether a submission through the client was under way as that read started. */
  outcomeDuringSubmission: boolean
  /** When that read failed; `undefined` when it succeeded. */
  failedAt: number | undefined
}

/** A read of one address in flight, which later callers share while it may answer them. */
interface QbitTotalRead {
  /** `false` once it settled when what it read was dropped (a clear, or the wallet reads locked). */
  readonly settled: Promise<boolean>
  /** Its rank (`begin`), taken as it started. */
  readonly order: number
  /** Whether a submission through its client was under way as it started. */
  readonly duringSubmission: boolean
}

/**
 * What the calls a `clear` overtakes answer: with no total (`'answer-none'`),
 * or, when the wallets that stay are the same wallets on the same network
 * (the controller's two: a wallet's removal, and the regtest access turned
 * off while on another network), with one more read of their own
 * (`'may-read-again'`, see `mayReadAgain`).
 */
export type QbitAccountTotalsClearKind = 'answer-none' | 'may-read-again'

/** What is kept for one client between two clears. */
interface QbitClientTotals {
  readonly kept: Map<string, QbitKeptTotal>
  readonly reading: Map<string, QbitTotalRead>
}

/** What a client's submissions left, kept across clears: the explorer lags them whatever the wallet forgot. */
interface QbitClientSubmissions {
  /** Submissions through the client under way. */
  inFlight: number
  /** The last rank taken before the client's latest invalidation; 0 with none. */
  invalidatedThrough: number
  /** The clock at that invalidation; `undefined` with none. */
  invalidatedAt: number | undefined
}

/** The answer for an address with no total to show: nothing measured, nothing failed. */
export function qbitNoAccountTotal(address: string, chainType: ChainType): QbitAccountTotal {
  return { address, chainType, totalBalance: null, readAt: null, fresh: false, error: false }
}

/** Refuse, with an `Error`, anything but a non-empty string as an address. */
export function assertQbitAccountTotalAddress(address: unknown): asserts address is string {
  if (typeof address !== 'string' || address.length === 0) {
    throw new Error('address must be a non-empty string')
  }
}

/**
 * Refuse, with an `Error`, anything but an array of at most
 * `QBIT_ACCOUNT_TOTALS_MAX_ADDRESSES` non-empty strings. A hole counts as
 * an entry, as `null` does, which is what `NaN` and a hole become over the
 * UI port.
 */
export function assertQbitAccountTotalAddresses(addresses: unknown): asserts addresses is string[] {
  if (!Array.isArray(addresses)) throw new Error('addresses must be an array')
  if (addresses.length > QBIT_ACCOUNT_TOTALS_MAX_ADDRESSES) {
    throw new Error(`addresses must hold at most ${QBIT_ACCOUNT_TOTALS_MAX_ADDRESSES} entries`)
  }
  for (let index = 0; index < addresses.length; index += 1) {
    const address: unknown = addresses[index]
    if (typeof address !== 'string' || address.length === 0) {
      throw new Error('addresses must be non-empty strings')
    }
  }
}

const isMeasuredTotal = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * `reading`, or a rejection with `signal`'s reason as soon as it aborts,
 * whichever comes first: a read a clear cancelled gives up its limiter slot
 * at once, however long its request takes to stop.
 */
function untilAborted<T>(reading: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    reading.catch(() => undefined)
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    reading.then(
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

/**
 * The account switcher's totals: each address's confirmed and unconfirmed
 * value together, from one small read of its statistics
 * (`getAddressBalance`, `GET /address/:address`), kept per API client and
 * address so a switcher reopened within `QBIT_ACCOUNT_TOTAL_FRESH_MS` reads
 * nothing. The home screen's balance feeds it too (`measured`), so the
 * current account, polled every ten seconds, rarely needs a read of its own;
 * a total it feeds soon after a submission, or while one is under way, is
 * not kept at all, since its request is no fresh read and may be answered
 * from before the submission.
 *
 * Reads through one client keep at most `maxReadsInFlight` in flight, on a
 * limiter of their own, first come first served, each under one deadline
 * the client enforces, and each a fresh read: a request of its own, never
 * joined to another caller's nor answered from an HTTP cache. A read of an
 * address already in flight here is shared, unless it began before the
 * client's latest invalidation or while a submission through it was under
 * way: a call then starts a read of its own, and that one still settles
 * for its own callers. A failed read keeps the last total measured, never a
 * 0 for one that was not, and no read of that address is made again for
 * `QBIT_ACCOUNT_TOTAL_RETRY_AFTER_MS`, unless the failed read began before
 * the client's latest invalidation or while a submission through it was
 * under way: its failure says nothing of the explorer after the submission.
 *
 * Each call takes its place (`begin`) when it begins, before its first
 * await, and a read takes another as its request starts. What a read
 * settles with is kept only if, then, no `clear` came after those places,
 * the wallet does not read locked (`usable`), and no total from a read that
 * began later is already kept for the address; a call a clear overtook
 * answers with no total, and may read once more after a clear that lets it
 * (`mayReadAgain`).
 *
 * `submission`, which the controller opens around every submission of a
 * transaction to an explorer, invalidates the client's totals as it opens
 * and as it closes (`invalidate`): each stays, to be shown while it is read
 * again, but is no longer fresh. A total measured by a read that began
 * before an invalidation, or that settles while a submission through its
 * client is under way, is kept but not fresh, since it may predate the
 * submission; one measured by a read that began within
 * `QBIT_ACCOUNT_TOTAL_SETTLING_MS` after the latest invalidation is fresh
 * only for `QBIT_ACCOUNT_TOTAL_SETTLING_FRESH_MS`, since the explorer may
 * not show the transaction yet.
 *
 * Clients are held weakly, as in `QbitFundingTxReads`: totals read through
 * one client are never served through another, so never for another network
 * or endpoint. In memory only. `clear` forgets every total and every read in
 * flight, which later callers no longer share, and aborts every read begun
 * before it: one still waiting for a slot sends nothing, and one in flight
 * is cancelled and gives up its slot at once, so reads begun after the
 * clear wait behind none of them.
 */
export class QbitAccountTotals {
  readonly maxReadsInFlight: number
  readonly readDeadlineMs: number
  private readonly now: () => number
  private readonly usable: () => boolean
  private readonly limiters = new WeakMap<object, QbitReadLimiter>()
  private readonly submissions = new WeakMap<object, QbitClientSubmissions>()
  private clients = new WeakMap<object, QbitClientTotals>()
  /** Aborted by the next `clear`: the signal of every read begun since the last one. */
  private generation = new AbortController()
  /** The last rank taken. */
  private started = 0
  /** The last rank taken before the latest `clear`. */
  private cleared = 0
  /** The last rank taken before the latest `clear` of the `'answer-none'` kind. */
  private clearedForGood = 0

  constructor(options: QbitAccountTotalsOptions = {}) {
    this.now = options.now ?? ((): number => Date.now())
    this.usable = options.usable ?? ((): boolean => true)
    this.maxReadsInFlight = options.maxReadsInFlight ?? QBIT_ACCOUNT_TOTALS_MAX_READS_IN_FLIGHT
    this.readDeadlineMs = options.readDeadlineMs ?? QBIT_ACCOUNT_TOTAL_READ_DEADLINE_MS
    if (
      !Number.isFinite(this.readDeadlineMs) ||
      this.readDeadlineMs <= 0 ||
      this.readDeadlineMs > 0x7fff_ffff
    ) {
      throw new Error('readDeadlineMs must be a positive number of milliseconds')
    }
    // Checked by the limiter's own constructor too; here so a bad bound
    // fails at once, not on the first read.
    if (!Number.isSafeInteger(this.maxReadsInFlight) || this.maxReadsInFlight < 1) {
      throw new Error('maxReadsInFlight must be a positive integer')
    }
  }

  /**
   * A read's place among the clears and invalidations, and among the other
   * reads of an address: taken when its call begins, before its first await,
   * and passed to `read` or `measured` when it settles.
   */
  begin(): QbitAccountTotalPlace {
    this.started += 1
    return { order: this.started, at: this.now() }
  }

  /** What is kept of `address` on `client`, as an answer now. Reads nothing. */
  peek(client: object, address: string, chainType: ChainType): QbitAccountTotal {
    if (!this.usable()) return qbitNoAccountTotal(address, chainType)
    return this.answer(this.clients.get(client)?.kept.get(address), address, chainType)
  }

  /**
   * The total of `address` through `client`: the kept one while it is
   * fresh, what is kept with `error: true` within
   * `QBIT_ACCOUNT_TOTAL_RETRY_AFTER_MS` of a failed read that began after
   * the client's latest invalidation and outside a submission, and
   * otherwise a read, shared with one already in flight unless that one began before
   * the client's latest invalidation or during a submission. `since` is the
   * place the caller took when its call began (`begin`); a clear after it
   * answers with no total and reads nothing. Never rejects.
   */
  async read(
    client: QbitAccountTotalsClient,
    address: string,
    chainType: ChainType,
    since: QbitAccountTotalPlace = this.begin()
  ): Promise<QbitAccountTotal> {
    if (!this.open(since)) return qbitNoAccountTotal(address, chainType)
    const totals = this.totalsOf(client)
    const kept = totals.kept.get(address)
    const now = this.now()
    if (kept && (this.isFresh(kept, now) || this.failedRecently(client, kept, now))) {
      return this.answer(kept, address, chainType)
    }
    let reading = totals.reading.get(address)
    if (!reading || !this.mayAnswerFrom(client, reading)) {
      reading = this.startRead(client, totals, address)
      totals.reading.set(address, reading)
    }
    const counted = await reading.settled
    if (!counted || !this.open(since)) return qbitNoAccountTotal(address, chainType)
    return this.peek(client, address, chainType)
  }

  /**
   * Keep `totalBalance`, measured by a read of `address` through `client`
   * that took its place at `since`, under the same rules as a read of its
   * own: the home screen's balance (`getAddressBalanceV2`) feeds it. It
   * counts as measured when that read began, since its statistics arrived
   * at some point after. That read is no fresh read: its request may have
   * been answered from an HTTP cache, or joined to one sent earlier. So
   * nothing of it is kept when it began before its client's latest
   * invalidation or within `QBIT_ACCOUNT_TOTAL_SETTLING_MS` after it, or
   * when it settles while a submission through the client is under way:
   * kept, it would take its rank and outrank a read of its own that began
   * earlier, whose fresh total would then be dropped. The invalidation
   * already left the kept total not fresh, so the switcher reads the
   * account itself. A value that is not a measured total (a non-negative
   * safe integer) is not kept.
   */
  measured(
    client: object,
    address: string,
    totalBalance: unknown,
    since: QbitAccountTotalPlace
  ): void {
    if (!isMeasuredTotal(totalBalance) || !this.open(since)) return
    const submissions = this.submissions.get(client)
    if (
      submissions !== undefined &&
      (this.measuredBeforeSubmission(submissions, since) || this.settlingAt(submissions, since))
    ) {
      return
    }
    this.settle(client, this.totalsOf(client), address, since, totalBalance, since.at, false)
  }

  /**
   * A submission of a transaction through `client` begins: its totals are
   * invalidated now and again when the returned function is called, once
   * the submission settled, whatever its outcome; in between, a total that
   * settles is kept but not fresh. The function does its work once.
   */
  submission(client: object): () => void {
    const submissions = this.submissionsOf(client)
    submissions.inFlight += 1
    this.invalidate(client)
    let ended = false
    return (): void => {
      if (ended) return
      ended = true
      this.invalidate(client)
      submissions.inFlight -= 1
    }
  }

  /**
   * The wallet submitted, or is about to submit, a transaction through
   * `client`: none of its totals is fresh any more, a read that began
   * before now is kept but not fresh, and one that begins within
   * `QBIT_ACCOUNT_TOTAL_SETTLING_MS` is fresh for less long. The totals stay,
   * to be shown while they are read again.
   */
  invalidate(client: object): void {
    const submissions = this.submissionsOf(client)
    submissions.invalidatedThrough = this.started
    submissions.invalidatedAt = this.now()
    const totals = this.clients.get(client)
    if (totals) for (const kept of totals.kept.values()) kept.stale = true
  }

  /**
   * Forget every total, and abort every read begun before this: one waiting
   * for a slot sends nothing, one in flight is cancelled. A call begun
   * before this keeps nothing and answers with no total; after a clear of
   * the `'may-read-again'` kind, its caller may read once more
   * (`mayReadAgain`).
   */
  clear(kind: QbitAccountTotalsClearKind = 'answer-none'): void {
    const aborted = this.generation
    this.generation = new AbortController()
    this.clients = new WeakMap()
    this.cleared = this.started
    if (kind === 'answer-none') this.clearedForGood = this.started
    aborted.abort(new Error('Qbit account totals cleared'))
  }

  /**
   * Whether a call that took its place at `since` was overtaken by a clear,
   * every one of them of the `'may-read-again'` kind: it answered, or will,
   * with no total, and its caller may read once more under a new place.
   */
  mayReadAgain(since: QbitAccountTotalPlace): boolean {
    return since.order <= this.cleared && since.order > this.clearedForGood
  }

  /** Whether a read that took its place at `since` may still keep and be served. */
  private open(since: QbitAccountTotalPlace): boolean {
    return since.order > this.cleared && this.usable()
  }

  /**
   * Whether a call that begins now may wait on `reading` for its answer:
   * not when it began before its client's latest invalidation, nor while a
   * submission through it was under way, since it may then measure the
   * total from before that submission.
   */
  private mayAnswerFrom(client: object, reading: QbitTotalRead): boolean {
    const submissions = this.submissions.get(client)
    if (!submissions) return true
    return reading.order > submissions.invalidatedThrough && !reading.duringSubmission
  }

  private totalsOf(client: object): QbitClientTotals {
    let totals = this.clients.get(client)
    if (!totals) {
      totals = { kept: new Map(), reading: new Map() }
      this.clients.set(client, totals)
    }
    return totals
  }

  private submissionsOf(client: object): QbitClientSubmissions {
    let submissions = this.submissions.get(client)
    if (!submissions) {
      submissions = { inFlight: 0, invalidatedThrough: 0, invalidatedAt: undefined }
      this.submissions.set(client, submissions)
    }
    return submissions
  }

  private limiterOf(client: object): QbitReadLimiter {
    let limiter = this.limiters.get(client)
    if (!limiter) {
      limiter = new QbitReadLimiter(this.maxReadsInFlight)
      this.limiters.set(client, limiter)
    }
    return limiter
  }

  /**
   * Read `address` through `client`, taking the read's place as its request
   * starts: a caller that waited before asking (to check the address is the
   * wallet's own) is not ranked behind a read that began meanwhile.
   */
  private startRead(
    client: QbitAccountTotalsClient,
    totals: QbitClientTotals,
    address: string
  ): QbitTotalRead {
    const place = this.begin()
    const duringSubmission = (this.submissions.get(client)?.inFlight ?? 0) > 0
    const { signal } = this.generation
    const options: QbitAccountTotalReadOptions = {
      deadlineMs: this.readDeadlineMs,
      signal,
      fresh: true,
    }
    // The limiter holds the slot until the call settles, either way, or the
    // next clear aborts it. The in-flight mark goes before any caller hears
    // the outcome, so one that asks again at once meets the retry pause, not
    // this read.
    const done = (measuredTotal: number | undefined): boolean => {
      if (totals.reading.get(address) === read) totals.reading.delete(address)
      if (!this.open(place)) return false
      this.settle(client, totals, address, place, measuredTotal, this.now(), duringSubmission)
      return true
    }
    const read: QbitTotalRead = {
      order: place.order,
      duringSubmission,
      settled: this.limiterOf(client)
        .run(() => untilAborted(client.getAddressBalance(address, options), signal), signal)
        .then(
          balance => done(isMeasuredTotal(balance?.totalSats) ? balance.totalSats : undefined),
          () => done(undefined)
        ),
    }
    return read
  }

  /**
   * Record the outcome of the read of `address` through `client` that took
   * its place at `place`: `measuredTotal`, measured at `readAt`, or a
   * failure when it is `undefined`; `duringSubmission` when a submission
   * through the client was under way as the read started. Only an open
   * read's outcome reaches here.
   */
  private settle(
    client: object,
    totals: QbitClientTotals,
    address: string,
    place: QbitAccountTotalPlace,
    measuredTotal: number | undefined,
    readAt: number,
    duringSubmission: boolean
  ): void {
    let kept = totals.kept.get(address)
    if (!kept) {
      kept = {
        totalBalance: null,
        readAt: null,
        measuredBy: 0,
        stale: false,
        freshForMs: QBIT_ACCOUNT_TOTAL_FRESH_MS,
        outcomeOf: 0,
        outcomeDuringSubmission: false,
        failedAt: undefined,
      }
      totals.kept.set(address, kept)
    }
    if (measuredTotal !== undefined && place.order > kept.measuredBy) {
      const submissions = this.submissions.get(client)
      kept.totalBalance = measuredTotal
      kept.readAt = readAt
      kept.measuredBy = place.order
      kept.stale = submissions !== undefined && this.measuredBeforeSubmission(submissions, place)
      kept.freshForMs =
        submissions !== undefined && this.settlingAt(submissions, place)
          ? QBIT_ACCOUNT_TOTAL_SETTLING_FRESH_MS
          : QBIT_ACCOUNT_TOTAL_FRESH_MS
    }
    if (place.order > kept.outcomeOf) {
      kept.outcomeOf = place.order
      kept.outcomeDuringSubmission = duringSubmission
      kept.failedAt = measuredTotal === undefined ? this.now() : undefined
    }
  }

  /**
   * Whether what a read that took its place at `place` measures, settling
   * now, may predate a submission through its client: it began before the
   * latest invalidation, or a submission is under way.
   */
  private measuredBeforeSubmission(
    submissions: QbitClientSubmissions,
    place: QbitAccountTotalPlace
  ): boolean {
    return place.order <= submissions.invalidatedThrough || submissions.inFlight > 0
  }

  /**
   * Whether a read that took its place at `place` began within
   * `QBIT_ACCOUNT_TOTAL_SETTLING_MS` after its client's latest invalidation,
   * while the explorer may still lag it. A clock that went back since the
   * invalidation counts as within it.
   */
  private settlingAt(submissions: QbitClientSubmissions, place: QbitAccountTotalPlace): boolean {
    return (
      submissions.invalidatedAt !== undefined &&
      place.at - submissions.invalidatedAt < QBIT_ACCOUNT_TOTAL_SETTLING_MS
    )
  }

  private isFresh(kept: QbitKeptTotal, now: number): boolean {
    if (kept.totalBalance === null || kept.readAt === null) return false
    if (kept.stale || kept.failedAt !== undefined) return false
    const age = now - kept.readAt
    return age >= 0 && age < kept.freshForMs
  }

  /**
   * Within the pause after the latest read of it failed, when that read
   * began after its client's latest invalidation and outside a submission:
   * the failure of one begun earlier says nothing of the explorer after the
   * submission, and a call then reads.
   */
  private failedRecently(client: object, kept: QbitKeptTotal, now: number): boolean {
    if (kept.failedAt === undefined) return false
    const submissions = this.submissions.get(client)
    if (
      submissions !== undefined &&
      (kept.outcomeOf <= submissions.invalidatedThrough || kept.outcomeDuringSubmission)
    ) {
      return false
    }
    const since = now - kept.failedAt
    return since >= 0 && since < QBIT_ACCOUNT_TOTAL_RETRY_AFTER_MS
  }

  private answer(
    kept: QbitKeptTotal | undefined,
    address: string,
    chainType: ChainType
  ): QbitAccountTotal {
    if (!kept) return qbitNoAccountTotal(address, chainType)
    return {
      address,
      chainType,
      totalBalance: kept.totalBalance,
      readAt: kept.readAt,
      fresh: this.isFresh(kept, this.now()),
      error: kept.failedAt !== undefined,
    }
  }
}
