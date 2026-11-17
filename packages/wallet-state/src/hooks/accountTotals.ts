import { useEffect, useMemo, useRef, useState } from 'react'

import type { QbitAccountTotal, WalletKeyring } from '@qbit/wallet-shared'
import type { ChainType } from '@qbit/wallet-types'

import { useWallet } from '../context/WalletContext'
import {
  type AccountTotalEntry,
  type AccountTotalUpdate,
  accountTotalsAsked,
  hasAccountBalanceRead,
  isChainType,
  isSatoshiAmount,
  storeAccountTotals,
} from '../reducers/accounts'
import { useAppDispatch, useAppSelector } from './base'

/** One account's total as the account switcher shows it, on the current network. */
export interface AccountTotalView {
  /** In sats; `null` while none is known. */
  totalBalance: number | null
  /**
   * `totalBalance` may not be the total now: the latest read did not measure
   * it, so it is the last one measured, or the read says it may be from
   * before a transaction the wallet submitted.
   */
  stale: boolean
  /** Not answered yet on this network since the switcher opened (always false while balances are hidden). */
  pending: boolean
}

export interface AccountSwitcherTotals {
  /** Balances are hidden: nothing is asked, and no total is to be shown. */
  hidden: boolean
  /** The total of each account the switcher asks about, by address. */
  totals: Readonly<Record<string, AccountTotalView>>
}

/** The current account's total as the home screen's balance card shows it. */
export interface CurrentAccountBalanceTotal {
  address: string
  /** In sats. */
  totalBalance: number
  /** The card's latest refresh failed: the total may be out of date. */
  stale: boolean
}

/** The most addresses the background takes in one request for kept totals. */
const KEPT_TOTALS_BATCH_LIMIT = 1024

/**
 * How long an answer waits for others before it is stored: answers that
 * arrive within this time of the first are stored, and shown, in one update.
 */
export const ACCOUNT_TOTAL_ANSWER_BATCH_MS = 50

/**
 * The most reads a switcher has out at once: as many as the background
 * reads from one explorer at a time. A read the page sends beyond that
 * waits in the background's queue, where no deadline applies, so the
 * switcher keeps it here, where closing the sheet drops it.
 */
export const ACCOUNT_TOTAL_READS_AT_ONCE = 4

// Shared by every switcher in the page, so the reducer can order the answers
// of all their requests, an earlier opening's included.
let lastAccountTotalRequestId = 0

const rowKey = (chainType: string, address: string): string => `${chainType}\n${address}`

/**
 * The background's answer for `address`, as it crossed the port, or
 * undefined when it is no answer for that address: another address, or a
 * network the wallet does not have. A total that is not a number of sats is
 * no total.
 */
function readAccountTotalAnswer(value: unknown, address: string): QbitAccountTotal | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const answer = value as { [field in keyof QbitAccountTotal]?: unknown }
  if (answer.address !== address) return undefined
  if (!isChainType(answer.chainType)) return undefined
  const totalBalance = isSatoshiAmount(answer.totalBalance) ? answer.totalBalance : null
  const readAt =
    totalBalance !== null && typeof answer.readAt === 'number' && Number.isFinite(answer.readAt)
      ? answer.readAt
      : null
  return {
    address,
    chainType: answer.chainType,
    totalBalance,
    readAt,
    fresh: totalBalance !== null && answer.fresh === true,
    error: answer.error === true,
  }
}

/**
 * What a kept total, the answer to request `requestId`, stores under the
 * network it names. One that is not fresh is read again, so it is not
 * settled: a failed last read makes it stale, and so does a stale mark
 * stored before it, which it does not clear (see `storeAccountTotals`).
 */
function keptUpdate(answer: QbitAccountTotal, requestId: number): AccountTotalUpdate {
  return {
    address: answer.address,
    chainType: answer.chainType,
    requestId,
    totalBalance: answer.totalBalance,
    readAt: answer.readAt,
    stale: answer.error,
    settled: answer.fresh,
  }
}

/**
 * What a read's answer, to request `requestId`, stores under the network it
 * names. Its total is stale when the read failed, and also when the read
 * does not call it fresh: it may be from before a transaction the wallet
 * submitted.
 */
function readUpdate(answer: QbitAccountTotal, requestId: number): AccountTotalUpdate {
  return {
    address: answer.address,
    chainType: answer.chainType,
    requestId,
    totalBalance: answer.totalBalance,
    readAt: answer.readAt,
    stale: answer.error || !answer.fresh,
    settled: true,
  }
}

/** A failed read of `address` on `chainType`: the total stored stays, as stale. */
function failedUpdate(
  address: string,
  chainType: ChainType,
  requestId: number
): AccountTotalUpdate {
  return {
    address,
    chainType,
    requestId,
    totalBalance: null,
    readAt: null,
    stale: true,
    settled: true,
  }
}

interface AnswerBatcher {
  /** Stores `updates` with the others that arrive within the batch time. */
  add(updates: AccountTotalUpdate[]): void
  /** Stores what is waiting now. */
  flush(): void
}

/**
 * Stores answers in one dispatch per `ACCOUNT_TOTAL_ANSWER_BATCH_MS`. An
 * update the store throws on is stored alone, then as a failed read; one it
 * refuses even so goes to `refused`, so its row still settles. Nothing here
 * throws.
 */
function createAnswerBatcher(
  dispatch: (action: ReturnType<typeof storeAccountTotals>) => unknown,
  refused: (updates: AccountTotalUpdate[]) => void
): AnswerBatcher {
  let queue: AccountTotalUpdate[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const store = (updates: AccountTotalUpdate[]): boolean => {
    try {
      dispatch(storeAccountTotals(updates))
      return true
    } catch {
      return false
    }
  }
  const flush = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (queue.length === 0) return
    const updates = queue
    queue = []
    if (store(updates)) return
    const unstored = updates.filter(
      update =>
        !store([update]) &&
        !store([failedUpdate(update.address, update.chainType, update.requestId)])
    )
    if (unstored.length > 0) {
      try {
        refused(unstored)
      } catch {
        // The rows stay as they are.
      }
    }
  }
  return {
    add(updates: AccountTotalUpdate[]): void {
      if (updates.length === 0) return
      queue.push(...updates)
      if (timer === undefined) timer = setTimeout(flush, ACCOUNT_TOTAL_ANSWER_BATCH_MS)
    },
    flush,
  }
}

/** One read a switcher is to send. */
interface ReadJob {
  address: string
  /** The visit that asks for it. */
  visit: Visit
  /** Sends it, and stores its answer; never rejects. */
  read(): Promise<void>
}

interface ReadPool {
  /** Queues `jobs` after those waiting, and sends what it may now. */
  add(jobs: ReadJob[]): void
}

/**
 * Sends a switcher's reads in the order queued, at most
 * `ACCOUNT_TOTAL_READS_AT_ONCE` out at a time: the next one goes once one
 * settles. A job `wanted` refuses when its turn comes is dropped, not sent.
 */
function createReadPool(wanted: (job: ReadJob) => boolean): ReadPool {
  let queue: ReadJob[] = []
  let next = 0
  let out = 0
  const settled = (): void => {
    out -= 1
    send()
  }
  const send = (): void => {
    while (out < ACCOUNT_TOTAL_READS_AT_ONCE && next < queue.length) {
      const job = queue[next]
      next += 1
      if (!wanted(job)) continue
      out += 1
      job.read().then(settled, settled)
    }
    if (next === queue.length) {
      queue = []
      next = 0
    }
  }
  return {
    add(jobs: ReadJob[]): void {
      queue.push(...jobs)
      send()
    },
  }
}

/**
 * The switcher on one network, from the first render on it: it asks about
 * each account once. Another network starts another visit, and so does
 * coming back to this one.
 */
interface Visit {
  chainType: ChainType
  /** The requests up to this one were made before the visit; their answers settle none of its rows. */
  floor: number
  /** The addresses asked about. */
  asked: Set<string>
}

/**
 * The addresses of every account of the wallets that are not corrupted: the
 * current wallet's first, then the others in list order, each once.
 */
function accountTotalAddresses(keyrings: WalletKeyring[], currentKeyringKey: string): string[] {
  const ordered = [
    ...keyrings.filter(keyring => keyring.key === currentKeyringKey),
    ...keyrings.filter(keyring => keyring.key !== currentKeyringKey),
  ]
  const addresses = new Set<string>()
  for (const keyring of ordered) {
    if ((keyring as WalletKeyring & { isCorrupted?: boolean }).isCorrupted === true) continue
    for (const account of keyring.accounts) {
      if (typeof account.address === 'string' && account.address !== '') {
        addresses.add(account.address)
      }
    }
  }
  return [...addresses]
}

/**
 * The totals the account switcher shows for the accounts of `keyrings`,
 * the wallets it lists. While it is open on a network, each account is asked
 * about once: first all together for the totals the background keeps, then
 * one read each for those whose kept total is not fresh. The reads go in
 * that order, the current wallet's first, with at most
 * `ACCOUNT_TOTAL_READS_AT_ONCE` out at a time; those still waiting when the
 * switcher closes, or the network changes, are not sent. Accounts the list
 * gains later are asked about the same way, and all of them again on coming
 * back to a network after another; nothing is polled or retried, and nothing
 * at all is asked while balances are hidden.
 *
 * A read's total that may be from before a transaction the wallet submitted
 * (not fresh) shows as stale, as one whose read failed does.
 *
 * Answers go to the store (`storeAccountTotals`), for the page's lifetime and
 * never saved, so the switcher opened again shows at once what it showed
 * before. Answers that arrive within `ACCOUNT_TOTAL_ANSWER_BATCH_MS` of each
 * other are stored in one update, and those still waiting when the switcher
 * closes are stored then. An answer replaces nothing a newer request's
 * answer stored, an answer for another network is no answer for this one,
 * and the answers of requests made before a reset are dropped.
 */
export function useAccountSwitcherTotals(keyrings: WalletKeyring[]): AccountSwitcherTotals {
  const wallet = useWallet()
  const dispatch = useAppDispatch()
  const hidden = useAppSelector(state => state.ui.isBalanceHidden)
  const chainType = useAppSelector(state => state.settings.chainType)
  const currentKeyringKey = useAppSelector(state => state.keyrings.current.key)
  const stored = useAppSelector(state => {
    const map = state.accounts.accountTotalsMap
    return isChainType(chainType) && Object.prototype.hasOwnProperty.call(map, chainType)
      ? map[chainType]
      : undefined
  })
  const addresses = useMemo(
    () => accountTotalAddresses(keyrings, currentKeyringKey),
    [keyrings, currentKeyringKey]
  )

  const visitRef = useRef<Visit | null>(null)
  let visit = visitRef.current
  if (visit === null || visit.chainType !== chainType) {
    visit = { chainType, floor: lastAccountTotalRequestId, asked: new Set() }
    visitRef.current = visit
  }
  const hiddenRef = useRef(hidden)
  hiddenRef.current = hidden
  const mountedRef = useRef(false)

  // The rows whose answers the store refused, by network and address, with
  // the request: they show as answered, without a total of their own.
  const [refused, setRefused] = useState<ReadonlyMap<string, number>>(() => new Map())
  const batcherRef = useRef<AnswerBatcher | null>(null)
  let batcher = batcherRef.current
  if (batcher === null) {
    batcher = createAnswerBatcher(dispatch, updates => {
      if (!mountedRef.current) return
      setRefused(previous => {
        const next = new Map(previous)
        for (const update of updates)
          next.set(rowKey(update.chainType, update.address), update.requestId)
        return next
      })
    })
    batcherRef.current = batcher
  }

  // A read waiting for its turn is sent only while the sheet is open, on
  // the network that asked for it, with balances shown. One that waited
  // while they were hidden is asked about again once they show; the others
  // are not asked in this opening, or in this visit.
  const poolRef = useRef<ReadPool | null>(null)
  let pool = poolRef.current
  if (pool === null) {
    pool = createReadPool(job => {
      if (!mountedRef.current || visitRef.current !== job.visit) return false
      if (hiddenRef.current) {
        job.visit.asked.delete(job.address)
        return false
      }
      return true
    })
    poolRef.current = pool
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // What is waiting is stored now; answers that come later, as they come.
      batcher.flush()
    }
  }, [batcher])

  useEffect(() => {
    if (hidden) return
    const toAsk = addresses.filter(address => !visit.asked.has(address))
    if (toAsk.length === 0) return
    for (const address of toAsk) visit.asked.add(address)
    const network = visit.chainType

    // An answer for another network is stored for that network, and counts
    // here as a failed read: an earlier total for this one shows as stale.
    const readTotal = async (address: string, requestId: number): Promise<void> => {
      let updates: AccountTotalUpdate[]
      try {
        const answer = readAccountTotalAnswer(await wallet.readQbitAccountTotal(address), address)
        if (answer === undefined) {
          updates = [failedUpdate(address, network, requestId)]
        } else if (answer.chainType === network) {
          updates = [readUpdate(answer, requestId)]
        } else {
          updates = [readUpdate(answer, requestId), failedUpdate(address, network, requestId)]
        }
      } catch {
        updates = [failedUpdate(address, network, requestId)]
      }
      batcher.add(updates)
    }

    // The kept totals of `batch`, then a read of each account without a
    // fresh one for this network. A kept answer without a total stores
    // nothing: the total stored stays as it is until the read answers. A
    // refused request (an older background, for one), or anything else that
    // goes wrong, leaves every account of the batch to its read.
    const askKept = async (batch: string[]): Promise<void> => {
      const keptRequestId = ++lastAccountTotalRequestId
      const reads = batch.map((address, index) => ({
        address,
        requestId: keptRequestId + 1 + index,
      }))
      lastAccountTotalRequestId += batch.length
      let toRead = reads
      try {
        dispatch(accountTotalsAsked(lastAccountTotalRequestId))
        let answers: unknown
        try {
          answers = await wallet.getQbitAccountTotals(batch)
        } catch {
          answers = undefined
        }
        const kept: AccountTotalUpdate[] = []
        toRead = reads.filter(({ address }, index) => {
          const answer = Array.isArray(answers)
            ? readAccountTotalAnswer(answers[index], address)
            : undefined
          if (answer === undefined) return true
          if (answer.totalBalance !== null) kept.push(keptUpdate(answer, keptRequestId))
          return !answer.fresh || answer.chainType !== network
        })
        batcher.add(kept)
      } catch {
        toRead = reads
      }
      // Through the pool, which sends nothing for a switcher that closed
      // meanwhile, nor while balances are hidden.
      pool.add(
        toRead.map(({ address, requestId }) => ({
          address,
          visit,
          read: () => readTotal(address, requestId),
        }))
      )
    }

    for (let start = 0; start < toAsk.length; start += KEPT_TOTALS_BATCH_LIMIT) {
      void askKept(toAsk.slice(start, start + KEPT_TOTALS_BATCH_LIMIT))
    }
  }, [hidden, addresses, visit, wallet, dispatch, batcher, pool])

  const totals = useMemo(() => {
    // Without a prototype, as the store's map: an address is a key like any other.
    const views = Object.create(null) as Record<string, AccountTotalView>
    for (const address of addresses) {
      const entry: AccountTotalEntry | undefined = stored?.[address]
      const totalBalance = entry?.totalBalance ?? null
      const refusedRequest = refused.get(rowKey(visit.chainType, address))
      const refusedHere = refusedRequest !== undefined && refusedRequest > visit.floor
      const answeredHere = entry !== undefined && entry.settled && entry.requestId > visit.floor
      views[address] = {
        totalBalance,
        stale: totalBalance !== null && (entry?.stale === true || refusedHere),
        pending: !hidden && !answeredHere && !refusedHere,
      }
    }
    return views
  }, [addresses, stored, refused, visit, hidden])

  return useMemo(() => ({ hidden, totals }), [hidden, totals])
}

/**
 * The current account's total once the home screen's balance card has one
 * read on the current network (not its stand-in zeros), else null: what the
 * switcher shows on that account's row, so the two never disagree.
 */
export function useCurrentAccountBalanceTotal(): CurrentAccountBalanceTotal | null {
  const address = useAppSelector(state => state.accounts.current.address)
  const totalBalance = useAppSelector(state => {
    const { accounts, settings } = state
    const current = accounts.current.address
    if (!current || !hasAccountBalanceRead(accounts, current, settings.chainType)) return null
    const total = accounts.balanceV2Map[current]?.totalBalance
    return isSatoshiAmount(total) ? total : null
  })
  const stale = useAppSelector(
    state => state.accounts.balanceStatusMap[state.accounts.current.address]?.error === true
  )
  return useMemo(
    () => (totalBalance === null ? null : { address, totalBalance, stale }),
    [address, totalBalance, stale]
  )
}
