import {
  isCompleteQbitBalance,
  type QbitBalanceReadProgress,
  type QbitBalanceSummary,
  type QbitKeptAddressBalance,
} from '@qbit/wallet-shared'
import type { ChainType } from '@qbit/wallet-types'

import type { QbitBalanceReadObserver } from './qbit-api'

/**
 * How many addresses' answers are kept per network (`QbitKeptBalances`), the
 * most recently read or served last: the accounts a user moves between, and
 * not every account a long session ever showed.
 */
export const QBIT_KEPT_BALANCES_PER_NETWORK = 8

/**
 * How often a balance read's output count is looked at, and sent when it
 * moved (`QbitBalanceProgressPublisher`): four times a second at most.
 */
export const QBIT_BALANCE_PROGRESS_INTERVAL_MS = 250

/** A page's `progressId` for a balance read: 1 to 64 letters, digits, `_` or `-`. */
export const QBIT_BALANCE_PROGRESS_ID = /^[A-Za-z0-9_-]{1,64}$/

/** Whether a balance answer is complete; the one definition, shared with the pages. */
export { isCompleteQbitBalance }

/** A read's place among the kept answers' clears (`QbitKeptBalances.begin`). */
export interface QbitKeptBalancePlace {
  readonly order: number
  /** When the read began, in ms since the epoch: what a kept answer is dated by. */
  readonly at: number
}

export interface QbitKeptBalancesOptions {
  /**
   * Whether answers may be kept or served now; the controller passes whether
   * the wallet reads unlocked. While it is false nothing is kept or served.
   */
  usable?: () => boolean
  /** The clock, in ms since the epoch; `Date.now` by default. */
  now?: () => number
  /** Addresses kept per network; `QBIT_KEPT_BALANCES_PER_NETWORK` by default. */
  maxPerNetwork?: number
}

interface QbitKeptEntry {
  balance: QbitBalanceSummary
  readAt: number
  order: number
}

/**
 * The last complete balance answer per network and address, in memory only,
 * for a newly opened page to show at once, dimmed, while its own first read
 * runs (`WalletController.getKeptAddressBalance`). Nothing is written to
 * storage.
 *
 * A read takes its place (`begin`) before its first await, and its answer is
 * kept only if nothing was cleared since then and the wallet still reads
 * unlocked: a read asked for before a lock, a reset or a network change
 * keeps nothing, however late it ends. Of two reads of one address, the
 * answer of the one begun later stays, whichever ends last. Each network
 * keeps the `maxPerNetwork` addresses most recently kept or served.
 */
export class QbitKeptBalances {
  private readonly networks = new Map<string, Map<string, QbitKeptEntry>>()
  private started = 0
  /** The last read begun before the latest `clear`. */
  private cleared = 0
  /** The last read begun before the latest `clear` or `forget`. */
  private forgotten = 0
  private readonly usable: () => boolean
  private readonly now: () => number
  private readonly maxPerNetwork: number

  constructor(options: QbitKeptBalancesOptions = {}) {
    this.usable = options.usable ?? ((): boolean => true)
    this.now = options.now ?? ((): number => Date.now())
    this.maxPerNetwork = Math.max(1, options.maxPerNetwork ?? QBIT_KEPT_BALANCES_PER_NETWORK)
  }

  /** The place of a read beginning now, before its first await. */
  begin(): QbitKeptBalancePlace {
    return { order: ++this.started, at: this.now() }
  }

  /**
   * Whether nothing was cleared since `place` was taken, and the wallet reads
   * unlocked: whether the read may still tell its page how it goes. A
   * `forget` does not end that.
   */
  current(place: QbitKeptBalancePlace): boolean {
    return place.order > this.cleared && this.usable()
  }

  /** Keep `balance`, the answer of the read at `place`, if it is complete and still may be kept. */
  keep(
    place: QbitKeptBalancePlace,
    chainType: ChainType,
    address: string,
    balance: QbitBalanceSummary
  ): void {
    if (!this.current(place) || place.order <= this.forgotten) return
    if (balance.chainType !== chainType) return
    if (!isCompleteQbitBalance(balance)) return
    let scoped = this.networks.get(chainType)
    if (scoped === undefined) {
      scoped = new Map()
      this.networks.set(chainType, scoped)
    }
    const stored = scoped.get(address)
    // A read begun later kept its answer already.
    if (stored !== undefined && stored.order > place.order) return
    scoped.delete(address)
    scoped.set(address, { balance: { ...balance }, readAt: place.at, order: place.order })
    for (const oldest of scoped.keys()) {
      if (scoped.size <= this.maxPerNetwork) break
      scoped.delete(oldest)
    }
  }

  /** The answer kept for `address` on `chainType`, as a copy; none while the wallet reads locked. */
  peek(chainType: ChainType, address: string): QbitKeptAddressBalance | undefined {
    if (!this.usable()) return undefined
    const scoped = this.networks.get(chainType)
    const entry = scoped?.get(address)
    if (scoped === undefined || entry === undefined) return undefined
    // Last in the map's order is the most recently used.
    scoped.delete(address)
    scoped.set(address, entry)
    return { balance: { ...entry.balance }, readAt: entry.readAt }
  }

  /**
   * Forget every answer, keep none of a read begun before now, and let no
   * such read tell its page anything more: for a lock, a reset, a network
   * change and the other clears of the kept reads.
   */
  clear(): void {
    this.cleared = this.started
    this.forget()
  }

  /**
   * Forget every answer and keep none of a read begun before now, but let
   * such a read go on telling its page how it goes: for a transaction going
   * out (`submission`), after which an answer may predate it.
   */
  forget(): void {
    this.forgotten = this.started
    this.networks.clear()
  }

  /**
   * A transaction is going out: forget the answers now, and again when it
   * settles (the returned function, called however it ends), so that no
   * read begun before it settled keeps an answer from before it.
   */
  submission(): () => void {
    this.forget()
    return (): void => this.forget()
  }
}

export interface QbitBalanceProgressOptions {
  progressId: string
  address: string
  chainType: ChainType
  /**
   * Whether the read may still tell its page anything: the wallet reads
   * unlocked, nothing was cleared since the read began, the address is still
   * the selected account's and the network still the one it began on.
   * Asked before every event.
   */
  mayPublish: () => boolean
  /** Hands an event to the page that asked for it. */
  send: (progress: QbitBalanceReadProgress) => void
  /** `QBIT_BALANCE_PROGRESS_INTERVAL_MS` by default. */
  intervalMs?: number
}

/**
 * Tells one page how its balance read goes: the total once the statistics
 * answered, then the output count, looked at every `intervalMs` and sent
 * only when it moved. `close`, which the read calls however it ends, stops
 * the timer: nothing is sent after it.
 */
export class QbitBalanceProgressPublisher {
  readonly observer: QbitBalanceReadObserver
  private timer: ReturnType<typeof setInterval> | undefined
  private closed = false
  /** The last count sent. */
  private lastCount: { read: number; total: number } | undefined

  constructor(private readonly options: QbitBalanceProgressOptions) {
    this.observer = { totalRead: (total, outputs): void => this.totalRead(total, outputs) }
  }

  private totalRead(
    totalBalance: number,
    outputs: () => { read: number; total: number } | undefined
  ): void {
    if (this.closed || this.timer !== undefined) return
    if (!Number.isSafeInteger(totalBalance) || totalBalance < 0) return
    const { progressId, address, chainType } = this.options
    this.publish({ progressId, kind: 'total', address, chainType, totalBalance })
    this.timer = setInterval(() => {
      const counted = outputs()
      if (counted === undefined) return
      const last = this.lastCount
      // Never back: a read that lists and classifies the outputs again (after
      // a retry of its statistics) counts on from where it was, while the
      // listing is the same size.
      const count =
        last !== undefined && last.total === counted.total
          ? { read: Math.max(last.read, counted.read), total: counted.total }
          : counted
      if (last !== undefined && last.read === count.read && last.total === count.total) return
      this.lastCount = count
      this.publish({ progressId, kind: 'outputs', address, chainType, ...count })
    }, this.options.intervalMs ?? QBIT_BALANCE_PROGRESS_INTERVAL_MS)
  }

  private publish(progress: QbitBalanceReadProgress): void {
    if (this.closed || !this.options.mayPublish()) return
    try {
      this.options.send(progress)
    } catch {
      // A page that cannot be told changes nothing in the read.
    }
  }

  close(): void {
    this.closed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }
}
