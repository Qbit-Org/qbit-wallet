import { afterEach, describe, expect, it, vi } from 'vitest'

import { EsploraClient } from '@qbit-oss/api'

import {
  getQbitSpendableBalanceV2,
  qbitStatsSnapshot,
  readQbitAddressUtxos,
  type QbitReadOutput,
} from '../src/utils/qbit-api'
import {
  QBIT_BALANCE_REUSE_MAX_AGE_MS,
  QBIT_BALANCE_REUSE_MIN_OUTPUTS,
  QBIT_BALANCE_REUSE_TIP_WAIT_MS,
  QbitBalanceReuse,
  type QbitKeptListing,
} from '../src/utils/qbit-balance-reuse'
import { QbitFundingTxReads } from '../src/utils/qbit-funding-tx-reads'
import { FOREIGN_SCRIPT, OTHER_ADDRESS } from './qbit-classify-reads-fake'
import { fakeTxid } from './qbit-fake-explorer'
import {
  FRESH_LISTING,
  FRESH_STATS,
  LISTING,
  POLL_MS,
  ReuseAccount,
  STATS,
  TIP,
  address,
  incomplete,
  route,
  script,
  split,
  sum,
  txReads,
  type ListedOutput,
  type PollOptions,
} from './qbit-balance-reuse-fixture'

/** A poll with nothing kept for the address: the listing goes out with the statistics. */
const LISTED = [STATS, TIP, LISTING]
/** A poll with an answer kept that it may not reuse: the listing, asked for fresh, may confirm it. */
const CONFIRMING = [STATS, TIP, FRESH_LISTING]
/** A poll that reuses the answer kept: the statistics, fresh, and the tip. */
const REUSED = [FRESH_STATS, TIP]
/** A poll that found the answer kept and read the listing after all, leaving the answer kept. */
const LISTED_LATE = [FRESH_STATS, TIP, FRESH_LISTING]
/** A poll that found the answer kept no longer applies, forgot it, and read the listing after all. */
const FORGOTTEN = [FRESH_STATS, TIP, LISTING]
/**
 * A poll whose tip did not answer in time: it set the answer aside and read
 * the listing late, as with nothing kept.
 */
const SET_ASIDE = [FRESH_STATS, TIP, LISTING]

/** A poll that asked for the listing, fresh or not, of which `requests` are the requests. */
const listed = (requests: readonly string[]): boolean =>
  requests.some(path => route(path).endsWith('/utxo'))

/** Let every request a poll has started reach the explorer. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20))

/** Confirm the answer: a candidate, then the identical listing asked for fresh. */
async function confirm(account: ReuseAccount): Promise<void> {
  expect((await account.poll()).requests.slice(0, 3)).toEqual(LISTED)
  expect((await account.poll()).requests.slice(0, 3)).toEqual(CONFIRMING)
}

/**
 * A send guard whose first read is held until `answer`; every later read
 * answers at once with what the account reserves.
 */
function holdGuard(account: ReuseAccount) {
  let asked: () => void = () => undefined
  const wasAsked = new Promise<void>(resolve => (asked = resolve))
  let answer: () => void = () => undefined
  const answered = new Promise<void>(resolve => (answer = resolve))
  const readReserved = vi.fn(async (): Promise<ReadonlySet<string>> => {
    if (readReserved.mock.calls.length === 1) {
      asked()
      await answered
    }
    return account.reserved
  })
  return { readReserved, asked: wasAsked, answer: (): void => answer() }
}

/** The listing with its first output a block lower: its count and value still agree with the statistics. */
const lowerFirst = (listing: ListedOutput[]) =>
  listing.map((utxo, index) =>
    index === 0
      ? { ...utxo, status: { ...utxo.status, block_height: (utxo.status.block_height ?? 0) - 1 } }
      : utxo
  )

describe('an unchanged large account, polled (W-F3)', () => {
  it('reads only the statistics, fresh, and the tip once a second identical listing, asked for fresh, confirmed the answer, which is what a fresh read gives', async () => {
    const account = new ReuseAccount({ young: 3 })
    // A reward 11 blocks deep, immature until the tip reaches 2,989.
    account.pay(5_000_000, { depth: 11, coinbase: true })
    const total = sum(account.payments)

    const first = await account.poll()
    expect(first.requests.slice(0, 3)).toEqual(LISTED)
    // The young payments and the reward, the only outputs read one by one.
    expect(txReads(first.requests)).toHaveLength(4)
    // A candidate is kept: the next listing is asked for fresh, and confirms it.
    expect((await account.poll()).requests).toEqual(CONFIRMING)

    for (let poll = 0; poll < 4; poll += 1) {
      const reused = await account.poll()
      expect(reused.requests).toEqual(REUSED)
      expect(reused.value).toEqual(split({ available: total - 5_000_000, immature: 5_000_000 }))
      expect(reused.value).toEqual(await account.fresh())
    }
  })

  it("works a reused split out for each poll's script exactly as a fresh read with that script does", async () => {
    const account = new ReuseAccount({ young: 1 })
    await confirm(account)

    const answers: string[] = []
    for (const p2mrScriptPubKey of [script, undefined, FOREIGN_SCRIPT]) {
      const read = await account.poll({ p2mrScriptPubKey })
      expect(read.requests).toEqual(REUSED)
      expect(read.value).toEqual(await account.fresh({ p2mrScriptPubKey }))
      answers.push(JSON.stringify(read.value))
    }
    // The address's own script, or none, counts every output it keeps;
    // another counts none: a split kept as the first poll worked it out
    // would be wrong for the last.
    expect(new Set(answers).size).toBe(2)
  })

  it('keeps nothing while an output listed under the address is answered as paying another script, and answers each poll as a fresh read with its script does', async () => {
    const account = new ReuseAccount({ young: 1 })
    // Listed under the account, paying another script: one young output, one deep.
    const foreign = account.pay(123_000, { depth: 20, script: FOREIGN_SCRIPT })
    account.pay(124_000, { depth: 1_500, script: FOREIGN_SCRIPT })

    const answers: string[] = []
    for (const p2mrScriptPubKey of [script, undefined, FOREIGN_SCRIPT, script]) {
      const read = await account.poll({ p2mrScriptPubKey })
      // Its transaction is read on every poll: the reader keeps no fact of it.
      expect(read.requests.slice(0, 3)).toEqual(LISTED)
      expect(txReads(read.requests)).toContain(foreign.txid)
      expect(read.value).toEqual(await account.fresh({ p2mrScriptPubKey }))
      answers.push(JSON.stringify(read.value))
    }
    expect(account.reuse.holds(account.client, address)).toBe(false)
    // Each script gives its own split.
    expect(new Set(answers).size).toBe(3)
  })

  it('asks for the listing fresh, with the statistics, on the poll after the first complete answer', async () => {
    const account = new ReuseAccount()
    expect((await account.poll()).requests).toEqual(LISTED)

    const statistics = account.hold(path => path === STATS)
    const second = account.start()
    await statistics.arrived
    // Only a candidate: the listing goes out before the statistics answer.
    await vi.waitFor(() => expect(second.requests()).toContain(FRESH_LISTING))
    statistics.release()
    await second.answer
    expect(second.requests()).toEqual(CONFIRMING)

    expect((await account.poll()).requests).toEqual(REUSED)
  })

  it('starts again from a second listing that differs, and reuses only once one is confirmed', async () => {
    const account = new ReuseAccount()
    expect((await account.poll()).requests).toEqual(LISTED)
    await account.serveListing(lowerFirst)
    expect((await account.poll()).requests).toEqual(CONFIRMING)
    account.explorer.failures.length = 0
    // The first listing again: it differs from the second, a candidate once more.
    expect((await account.poll()).requests).toEqual(CONFIRMING)
    expect((await account.poll()).requests).toEqual(CONFIRMING)
    expect((await account.poll()).requests).toEqual(REUSED)
  })

  it('confirms only with a listing asked for fresh, which no cache in front of the explorer answers', async () => {
    const account = new ReuseAccount()
    const reward = account.pay(5_000_000, { depth: 11, coinbase: true })
    const total = sum(account.payments)
    expect((await account.poll()).value).toEqual(
      split({ available: total - 5_000_000, immature: 5_000_000 })
    )
    // A cache holds that listing. Then a reorganisation at the same height
    // swaps the reward for a payment of the same value: the statistics read
    // as they did.
    await account.cacheListing()
    const before = qbitStatsSnapshot(account.explorer.stats(address))
    account.explorer.removeTx(reward.txid)
    const payment = account.pay(5_000_000, { depth: 11 })
    expect(qbitStatsSnapshot(account.explorer.stats(address))).toBe(before)

    // Five seconds on, within the cache's 10 s: the listing, asked for fresh,
    // shows the payment, a candidate of its own and no confirmation.
    const second = await account.poll({ advance: 5_000 })
    expect(second.requests).toEqual([...CONFIRMING, `/tx/${payment.txid}`])
    expect(second.value).toEqual(split({ available: total }))
    expect((await account.poll()).requests).toEqual(CONFIRMING)
    const reused = await account.poll()
    expect(reused.requests).toEqual(REUSED)
    expect(reused.value).toEqual(split({ available: total }))
  })

  it("asks for each listing that may confirm on its own, never joining another read's request in flight", async () => {
    const account = new ReuseAccount()
    expect((await account.poll()).requests).toEqual(LISTED)

    // Another reader of the balance 5 s later, its listing held in flight.
    const held = account.hold(path => route(path) === LISTING)
    const from = account.sent.length
    const other = account.start({ advance: 5_000 })
    await held.arrived
    // The card's poll 5 s after that asks for the listing on its own.
    const card = account.start({ advance: 5_000 })
    await vi.waitFor(() =>
      expect(account.sent.slice(from).filter(path => route(path) === LISTING)).toEqual([
        FRESH_LISTING,
        FRESH_LISTING,
      ])
    )
    held.release()
    await other.answer
    await card.answer
    expect((await account.poll()).requests).toEqual(REUSED)
  })

  it('never lets a read confirm an answer kept after it began', async () => {
    const account = new ReuseAccount()
    expect((await account.poll()).requests).toEqual(LISTED)
    // From now on the listing differs from the candidate's.
    await account.serveListing(lowerFirst)

    // Two polls begun together, each asking for the listing fresh. The first
    // keeps a new candidate; the second, begun before that, waits for the
    // send guard until it is kept, and confirms nothing.
    const first = account.start()
    let guardAsked: () => void = () => undefined
    const asked = new Promise<void>(resolve => (guardAsked = resolve))
    let answerGuard: () => void = () => undefined
    const second = account.start({
      advance: 0,
      readReserved: () => {
        guardAsked()
        return new Promise<ReadonlySet<string>>(resolve => (answerGuard = () => resolve(new Set())))
      },
    })
    await first.answer
    await asked
    answerGuard()
    await second.answer
    expect(first.requests().filter(path => path === FRESH_LISTING)).toHaveLength(2)

    // The next poll confirms the first one's candidate; only the one after it reuses.
    expect((await account.poll()).requests).toEqual(CONFIRMING)
    expect((await account.poll()).requests).toEqual(REUSED)
  })

  it('confirms only under the same statistics: the same listing under statistics that changed is a new candidate', async () => {
    const account = new ReuseAccount()
    expect((await account.poll()).requests).toEqual(LISTED)
    // From now on the listing reads as it does now.
    await account.serveListing(listing => listing)
    // An output spent and one of the same value received: the statistics
    // change, the unspent count and value do not, so the listing still
    // agrees with them.
    const spent = account.payments[0]!
    const before = qbitStatsSnapshot(account.explorer.stats(address))
    account.explorer.addTx({
      txid: fakeTxid(1, 66_000_000),
      inputs: [{ txid: spent.txid, vout: 0 }],
      outputs: [{ script: FOREIGN_SCRIPT, value: 5_000 }],
      height: account.explorer.tipHeight,
    })
    account.pay(spent.outputs[0]!.value, { depth: 1 })
    expect(qbitStatsSnapshot(account.explorer.stats(address))).not.toBe(before)

    expect((await account.poll()).requests).toEqual(CONFIRMING)
    expect((await account.poll()).requests).toEqual(CONFIRMING)
    expect((await account.poll()).requests).toEqual(REUSED)
  })
})

describe('an answer kept only when nothing can make it wrong (W-F3)', () => {
  it('keeps and reuses nothing while a payment waits in the mempool, and reads the listing again once it is replaced by one with the same sums and counts (#128)', async () => {
    const account = new ReuseAccount()
    const pending = account.pay(7_000)
    // The listing lags the statistics: it does not show the payment, and its
    // count and value agree with the confirmed statistics.
    await account.serveListing(listing => listing.filter(utxo => utxo.status.confirmed))
    for (let poll = 0; poll < 3; poll += 1) {
      expect((await account.poll()).requests).toEqual(LISTED)
    }
    const before = qbitStatsSnapshot(account.explorer.stats(address))
    // Replaced by another payment of the same value: every sum and count as before.
    account.explorer.removeTx(pending.txid)
    account.pay(7_000)
    expect(qbitStatsSnapshot(account.explorer.stats(address))).toBe(before)
    for (let poll = 0; poll < 2; poll += 1) {
      const read = await account.poll()
      expect(read.requests).toEqual(LISTED)
      expect(read.value).toEqual(await account.fresh())
    }
  })

  it('reads the listing once the tip reaches the height at which a reward it counted immature matures, and after a rollback', async () => {
    const account = new ReuseAccount()
    account.pay(5_000_000, { depth: 11, coinbase: true })
    const total = sum(account.payments)
    await confirm(account)
    expect((await account.poll()).value).toEqual(
      split({ available: total - 5_000_000, immature: 5_000_000 })
    )

    // Blocks with nothing for the account: the statistics read as they did.
    account.explorer.tipHeight = 2_988
    const before = await account.poll()
    expect(before.requests).toEqual(REUSED)
    expect(before.value).toEqual(await account.fresh())

    // The reward matures at 2,989.
    account.explorer.tipHeight = 2_989
    const matured = await account.poll()
    expect(matured.requests).toEqual(LISTED_LATE)
    expect(matured.value).toEqual(split({ available: total }))
    expect(matured.value).toEqual(await account.fresh())
    // The same listing under the same statistics, asked for fresh, confirms the new answer.
    expect((await account.poll()).requests).toEqual(REUSED)

    // A rollback below the tip the answer was read at.
    account.explorer.tipHeight = 2_985
    const rolledBack = await account.poll()
    expect(rolledBack.requests).toEqual(LISTED_LATE)
    expect(rolledBack.value).toEqual(split({ available: total - 5_000_000, immature: 5_000_000 }))
    expect(rolledBack.value).toEqual(await account.fresh())
  })

  for (const [kind, prepare] of [
    [
      'a funding transaction cannot be read',
      async (account: ReuseAccount) => {
        const young = account.payments.at(-1)!
        account.explorer.failures.push(({ path }) =>
          path === `/tx/${young.txid}` ? { status: 404, body: 'not found' } : undefined
        )
        const read = await account.poll()
        expect(read.value).toEqual(incomplete(sum(account.payments), true))
        account.explorer.failures.length = 0
      },
    ],
    [
      'the deadline cuts it off',
      async (account: ReuseAccount) => {
        const young = account.payments.at(-1)!
        account.explorer.slowResponses.push({
          match: ({ path }) => path === `/tx/${young.txid}`,
          chunkBytes: 1,
          intervalMs: 1_000,
          stallHeaders: true,
        })
        const read = await account.poll({ deadlineMs: 300 })
        expect(read.value).toMatchObject({ availableBalance: null, utxoReadIncomplete: true })
        account.explorer.slowResponses.length = 0
      },
    ],
    [
      'more outputs are left to read than the reader keeps facts of',
      async (account: ReuseAccount) => {
        const capped = await account.poll({
          fundingTxReads: new QbitFundingTxReads({ maxOutpoints: 2 }),
        })
        expect(capped.value).toEqual(incomplete(sum(account.payments), true))
      },
    ],
    [
      'the listing fails',
      async (account: ReuseAccount) => {
        account.explorer.failures.push(({ path }) =>
          path === LISTING ? { status: 404, body: 'not found' } : undefined
        )
        const read = await account.poll()
        expect(read.value).toEqual(incomplete(sum(account.payments), true))
        account.explorer.failures.length = 0
      },
    ],
    [
      'the send guard does not answer by the deadline',
      async (account: ReuseAccount) => {
        const read = await account.poll({
          deadlineMs: 300,
          readReserved: () => new Promise<ReadonlySet<string>>(() => undefined),
        })
        expect(read.value).toEqual({
          availableBalance: null,
          unavailableBalance: sum(account.payments),
          totalBalance: sum(account.payments),
          immatureBalance: null,
          pendingBalance: null,
        })
      },
    ],
    [
      'the tip never answers',
      async (account: ReuseAccount) => {
        account.explorer.slowResponses.push({
          match: ({ path }) => path === TIP,
          chunkBytes: 1,
          intervalMs: 1_000,
          stallHeaders: true,
        })
        for (let poll = 0; poll < 2; poll += 1) {
          expect((await account.poll()).value).toEqual(split({ available: sum(account.payments) }))
        }
        account.explorer.slowResponses.length = 0
      },
    ],
  ] as const) {
    it(`keeps nothing from a read that did not complete when ${kind}`, async () => {
      const account = new ReuseAccount({ young: 3 })
      await prepare(account)
      // Nothing of it counts: the next poll is a candidate, and the one after it confirms it.
      expect((await account.poll()).requests.slice(0, 3)).toEqual(LISTED)
      expect((await account.poll()).requests).toEqual(CONFIRMING)
      expect((await account.poll()).requests).toEqual(REUSED)
    })
  }

  for (const [kind, change] of [
    [
      'one output more than the statistics count, worth nothing',
      (listing: ListedOutput[]) => [...listing, { ...listing[0]!, txid: 'f'.repeat(64), value: 0 }],
    ],
    [
      'a value one more than the statistics sum',
      (listing: ListedOutput[]) =>
        listing.map((utxo, index) => (index === 0 ? { ...utxo, value: utxo.value + 1 } : utxo)),
    ],
    [
      'an output listed unconfirmed while the statistics count none in the mempool',
      (listing: ListedOutput[]) =>
        listing.map((utxo, index) =>
          index === 0 ? { ...utxo, status: { ...utxo.status, confirmed: false } } : utxo
        ),
    ],
  ] as const) {
    it(`keeps nothing from a listing that disagrees with the statistics read with it: ${kind}`, async () => {
      const account = new ReuseAccount()
      await account.serveListing(change)
      for (let poll = 0; poll < 3; poll += 1) {
        expect((await account.poll()).requests.slice(0, 3)).toEqual(LISTED)
      }
    })
  }

  it('forgets a kept answer once a listing that may not be kept is read for it', async () => {
    const account = new ReuseAccount()
    expect((await account.poll()).requests).toEqual(LISTED)
    // From now on the listing shows one output more than the statistics count.
    await account.serveListing(listing => [
      ...listing,
      { ...listing[0]!, txid: 'f'.repeat(64), value: 0 },
    ])
    // Asked for fresh, as it could have confirmed the candidate.
    expect((await account.poll()).requests).toEqual(CONFIRMING)
    // It may not be kept: the candidate is gone, and the next listing is asked for as with nothing kept.
    expect((await account.poll()).requests).toEqual(LISTED)
  })

  it('reuses nothing under statistics of another address: it reads the listing, as a read with nothing kept does', async () => {
    const account = new ReuseAccount()
    await confirm(account)
    account.serveStats(stats => ({ ...stats, address: OTHER_ADDRESS }))
    const read = await account.poll()
    expect(read.requests).toEqual(FORGOTTEN)
    expect(read.value).toEqual(await account.fresh())
    expect((await account.poll()).requests).toEqual(LISTED)
  })
})

describe('a small account, polled (W-F3)', () => {
  for (const outputs of [50, QBIT_BALANCE_REUSE_MIN_OUTPUTS - 1]) {
    it(`reuses nothing of ${outputs} outputs, the listing going out before the statistics answer on every poll`, async () => {
      const account = new ReuseAccount({ deep: outputs })
      for (let poll = 0; poll < 4; poll += 1) {
        const statistics = account.hold(path => path === STATS)
        const read = account.start()
        await statistics.arrived
        await vi.waitFor(() => expect(read.requests()).toContain(LISTING))
        statistics.release()
        expect(await read.answer).toEqual(split({ available: sum(account.payments) }))
        expect(read.requests()).toEqual(LISTED)
      }
    })
  }

  it(`reuses the answer of ${QBIT_BALANCE_REUSE_MIN_OUTPUTS} outputs`, async () => {
    const account = new ReuseAccount({ deep: QBIT_BALANCE_REUSE_MIN_OUTPUTS })
    await confirm(account)
    expect((await account.poll()).requests).toEqual(REUSED)
  })
})

describe('the reservations, the age and changed statistics of a reused answer (W-F3)', () => {
  it('reads the send guard on every reused poll, and counts a reservation made between polls', async () => {
    const account = new ReuseAccount()
    const total = sum(account.payments)
    await confirm(account)
    account.readReserved.mockClear()
    const reused = await account.poll()
    expect(reused.requests).toEqual(REUSED)
    expect(reused.value).toEqual(split({ available: total }))
    expect(account.readReserved).toHaveBeenCalledTimes(1)

    // A send claims two outputs.
    const [first, second] = account.payments
    account.reserved = new Set([`${first!.txid}:0`, `${second!.txid}:0`])
    const held = first!.outputs[0]!.value + second!.outputs[0]!.value
    const claimed = await account.poll()
    expect(claimed.requests).toEqual(REUSED)
    expect(claimed.value).toEqual({
      availableBalance: total - held,
      unavailableBalance: held,
      totalBalance: total,
      immatureBalance: 0,
      pendingBalance: 0,
    })
    expect(claimed.value).toEqual(await account.fresh())
    expect(account.readReserved).toHaveBeenCalledTimes(2)
  })

  it('answers the total with the split unknown when the send guard does not answer a reused poll by the deadline, as a fresh read does', async () => {
    const account = new ReuseAccount()
    const total = sum(account.payments)
    await confirm(account)
    const hung = (): Promise<ReadonlySet<string>> => new Promise(() => undefined)

    const reused = await account.poll({ deadlineMs: 300, readReserved: hung })

    expect(reused.requests).toEqual(REUSED)
    expect(reused.value).toEqual({
      availableBalance: null,
      unavailableBalance: total,
      totalBalance: total,
      immatureBalance: null,
      pendingBalance: null,
    })
    await expect(
      getQbitSpendableBalanceV2(account.newClient(), address, script, hung, undefined, {
        deadlineMs: 300,
      })
    ).resolves.toEqual(reused.value)
  })

  it('reads the send guard again after the listing when the answer stops being reusable as it answers, and counts what a send reserved meanwhile', async () => {
    const account = new ReuseAccount()
    await confirm(account)
    const [first] = account.payments
    const readReserved = vi.fn(async (): Promise<ReadonlySet<string>> => {
      if (readReserved.mock.calls.length === 1) {
        // The answer's age runs out as the send guard answers: nothing reserved yet.
        account.time += QBIT_BALANCE_REUSE_MAX_AGE_MS
        account.wallTime += QBIT_BALANCE_REUSE_MAX_AGE_MS
        return new Set()
      }
      return account.reserved
    })
    const listing = account.hold(path => path === FRESH_LISTING)
    const read = account.start({ readReserved })
    await listing.arrived
    // A send reserves an output while the listing is read.
    account.reserved = new Set([`${first!.txid}:0`])
    listing.release()
    const value = await read.answer

    expect(read.requests()).toEqual(LISTED_LATE)
    expect(readReserved).toHaveBeenCalledTimes(2)
    expect(value).toEqual(await account.fresh())
    expect(value).toMatchObject({ unavailableBalance: first!.outputs[0]!.value })
  })

  it('reads the listing in full once the answer is past its age, and a clock set back does not stretch it', async () => {
    const account = new ReuseAccount()
    await confirm(account)
    // Confirmed by the read that began at 20 s.
    expect(account.time).toBe(2 * POLL_MS)
    expect((await account.poll({ advance: QBIT_BALANCE_REUSE_MAX_AGE_MS })).requests).toEqual(
      REUSED
    )
    expect((await account.poll({ advance: 1 })).requests).toEqual(CONFIRMING)
    // That read listed the same outputs under the same statistics: confirmed again.
    expect((await account.poll({ advance: 1 })).requests).toEqual(REUSED)

    // Both clocks set back a minute: too old, until a read confirms it again.
    expect((await account.poll({ advance: -60_000 })).requests).toEqual(CONFIRMING)
    expect((await account.poll({ advance: 0 })).requests).toEqual(REUSED)
  })

  it('measures the age on the wall clock too: a sleep the monotonic clock does not count, or a wall clock set back, ends the reuse', async () => {
    const account = new ReuseAccount()
    await confirm(account)
    expect((await account.poll()).requests).toEqual(REUSED)

    // An hour asleep, which the monotonic clock did not count.
    account.wallTime += 60 * 60_000
    expect((await account.poll({ advance: 0 })).requests).toEqual(CONFIRMING)
    expect((await account.poll({ advance: 0 })).requests).toEqual(REUSED)

    // The wall clock set back a minute.
    account.wallTime -= 60_000
    expect((await account.poll({ advance: 0 })).requests).toEqual(CONFIRMING)
    expect((await account.poll({ advance: 0 })).requests).toEqual(REUSED)
  })

  it('asks for the listing only once changed statistics have answered, asks for them once, and answers what a fresh read does', async () => {
    const account = new ReuseAccount()
    await confirm(account)
    const payment = account.pay(9_000, { depth: 1 })

    const statistics = account.hold(path => path === FRESH_STATS)
    const changed = account.start()
    await statistics.arrived
    await settle()
    expect(changed.requests()).toEqual(REUSED)
    statistics.release()
    const value = await changed.answer

    expect(changed.requests()).toEqual([...FORGOTTEN, `/tx/${payment.txid}`])
    expect(value).toEqual(await account.fresh())
    expect(value).toEqual(split({ available: sum(account.payments) }))
  })

  for (const [kind, change] of [
    [
      'a payment waits in the mempool',
      (account: ReuseAccount) => {
        account.pay(7_000)
      },
    ],
    [
      'the account is consolidated under 1,000 outputs',
      (account: ReuseAccount) => {
        for (const tx of account.payments.splice(0, 300)) account.explorer.removeTx(tx.txid)
      },
    ],
  ] as const) {
    it(`forgets the kept answer once its statistics change (${kind}), so later polls ask for the listing with the statistics again`, async () => {
      const account = new ReuseAccount()
      await confirm(account)
      change(account)
      // The poll that finds the change asks for the listing once the statistics answered.
      expect((await account.poll()).requests.slice(0, 3)).toEqual(FORGOTTEN)

      for (let poll = 0; poll < 3; poll += 1) {
        const statistics = account.hold(path => route(path) === STATS)
        const read = account.start()
        await statistics.arrived
        await vi.waitFor(() => expect(read.requests()).toContain(LISTING))
        statistics.release()
        expect(await read.answer).toEqual(await account.fresh())
        expect(read.requests().slice(0, 3)).toEqual(LISTED)
      }
    })
  }

  it('asks for the statistics fresh on a poll that would reuse, so a reply a cache holds never stands for them', async () => {
    const account = new ReuseAccount()
    await confirm(account)
    // A cache holds the statistics as they read now. Then another holder of
    // the key spends an output, in a block the wallet never saw in the mempool.
    account.cacheStats()
    const spent = account.payments[0]!
    account.explorer.addTx({
      txid: fakeTxid(1, 67_000_000),
      inputs: [{ txid: spent.txid, vout: 0 }],
      outputs: [{ script: FOREIGN_SCRIPT, value: spent.outputs[0]!.value - 100 }],
      height: account.explorer.tipHeight,
    })

    const read = await account.poll()

    // The statistics, read fresh, show the spend: the listing is read.
    expect(read.requests).toEqual(FORGOTTEN)
    expect(read.value).toEqual(
      split({ available: sum(account.payments) - spent.outputs[0]!.value })
    )
    account.explorer.failures.length = 0
    expect(read.value).toEqual(await account.fresh())
  })
})

describe('a tip that is late, hangs or fails on a poll with an answer to reuse (W-F3)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  for (const [kind, answersAfterMs, reused] of [
    ['answers within the wait', QBIT_BALANCE_REUSE_TIP_WAIT_MS / 2, true],
    ['answers after the wait', 3 * QBIT_BALANCE_REUSE_TIP_WAIT_MS, false],
    ['never answers', undefined, false],
  ] as const) {
    it(`answers as a read with nothing kept does, at most ${QBIT_BALANCE_REUSE_TIP_WAIT_MS} ms later, when the tip ${kind}`, async () => {
      const account = new ReuseAccount()
      await confirm(account)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

      // The poll, and then a read with nothing kept, each with its tip so.
      const timed = async (read: () => Promise<unknown>) => {
        const tip = account.hold(path => path === TIP)
        const answer = read()
        await tip.arrived
        if (answersAfterMs !== undefined) setTimeout(() => tip.release(), answersAfterMs)
        const ms = await settledAfter(answer)
        return { value: await answer, ms, release: tip.release }
      }
      const from = account.sent.length
      const poll = await timed(() => account.start().answer)
      const requests = account.sent.slice(from)
      const base = await timed(() => account.fresh())

      expect(poll.value).toEqual(base.value)
      expect(base.value).toEqual(split({ available: sum(account.payments) }))
      // Without the tip, the listing alone shows few outputs deep: the rest are read one by one, by both.
      expect(requests.slice(0, 3)).toEqual(reused ? REUSED : SET_ASIDE)
      expect(poll.ms).toBeLessThanOrEqual(base.ms + QBIT_BALANCE_REUSE_TIP_WAIT_MS + STEP_MS)
      if (!reused) expect(poll.ms).toBeGreaterThanOrEqual(QBIT_BALANCE_REUSE_TIP_WAIT_MS)
      poll.release()
      base.release()

      // Reused, it stays so; set aside, the next poll reads as with nothing kept.
      expect((await account.poll()).requests).toEqual(reused ? REUSED : LISTED)
    })
  }

  it('reads the listing at once, and answers as a read with nothing kept does, when the tip fails', async () => {
    const account = new ReuseAccount()
    await confirm(account)
    account.explorer.failures.push(({ path }) =>
      path === TIP ? { status: 404, body: 'not found' } : undefined
    )
    const read = await account.poll()
    expect(read.requests.slice(0, 3)).toEqual(SET_ASIDE)
    expect(read.value).toEqual(await account.fresh())
  })

  it('ends a poll whose deadline passes while it waits for the tip as a read cut off by it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const account = new ReuseAccount()
    await confirm(account)
    const statistics = account.hold(path => path === FRESH_STATS)
    const tip = account.hold(path => path === TIP)
    const read = account.start({ deadlineMs: 2_000 })
    const outcome = track(read.answer)
    await statistics.arrived
    await vi.advanceTimersByTimeAsync(1_500)
    statistics.release()
    await settledAfter(read.answer)

    expect(outcome.value).toEqual(incomplete(sum(account.payments), true))
    tip.release()
    // The tip did not answer in time: set aside.
    expect((await account.poll()).requests).toEqual(LISTED)
  })
})

describe('reads that overlap, run out of time or are given up on (W-F3)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('never lets an older read that completes last replace what a newer one kept', async () => {
    const account = new ReuseAccount()
    // The older read waits for the send guard once its listing is in.
    let guardAsked: () => void = () => undefined
    const asked = new Promise<void>(resolve => (guardAsked = resolve))
    let answerGuard: () => void = () => undefined
    const older = account.start({
      readReserved: () => {
        guardAsked()
        return new Promise<ReadonlySet<string>>(resolve => (answerGuard = () => resolve(new Set())))
      },
    })
    await asked
    expect(older.requests()).toEqual(LISTED)
    // A payment, and a newer read of it that completes first.
    account.pay(9_000, { depth: 1_500 })
    const newer = await account.poll()
    expect(newer.requests).toEqual(LISTED)
    answerGuard()
    await older.answer

    // The newer read's answer is the candidate the next poll confirms.
    expect((await account.poll()).requests).toEqual(CONFIRMING)
    expect((await account.poll()).requests).toEqual(REUSED)
  })

  it('stops a listing asked for after the statistics at the one deadline, and leaves the kept answer as it was', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const account = new ReuseAccount()
    await confirm(account)
    const total = sum(account.payments)
    // The tip a block lower: the answer is not reused, and the listing is
    // asked for once the statistics have answered.
    account.explorer.tipHeight -= 1

    const statistics = account.hold(path => path === FRESH_STATS)
    const listing = account.hold(path => path === FRESH_LISTING)
    const changed = track(account.start({ deadlineMs: 5_000 }).answer)
    await statistics.arrived
    await vi.advanceTimersByTimeAsync(3_000)
    statistics.release()
    await listing.arrived
    await vi.advanceTimersByTimeAsync(1_999)
    expect(changed.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    // Five seconds from the start, the listing two of them in.
    expect(changed).toMatchObject({ settled: true, value: incomplete(total, true) })
    listing.release()

    // The tip back where it was: still reused.
    account.explorer.tipHeight += 1
    expect((await account.poll()).requests).toEqual(REUSED)
  })

  it('keeps nothing from a read given up on while it waits for the send guard, nor from one that hears it gave up as the guard answers', async () => {
    const account = new ReuseAccount()
    expect((await account.poll()).requests).toEqual(LISTED)

    // The read that would confirm the candidate, given up on as it waits.
    const caller = new AbortController()
    let guardAsked: () => void = () => undefined
    const asked = new Promise<void>(resolve => (guardAsked = resolve))
    const given = account.start({
      signal: caller.signal,
      readReserved: () => {
        guardAsked()
        return new Promise<ReadonlySet<string>>(() => undefined)
      },
    })
    await asked
    caller.abort(new Error('closed'))
    await expect(given.answer).rejects.toThrow('closed')

    // One that hears it was given up on as the guard answers.
    const late = new AbortController()
    const heard = account.start({
      signal: late.signal,
      readReserved: () =>
        ({
          then(resolve: (reserved: ReadonlySet<string>) => void) {
            resolve(new Set())
            late.abort(new Error('closed late'))
          },
        }) as unknown as Promise<ReadonlySet<string>>,
    })
    await expect(heard.answer).rejects.toThrow('closed late')

    // The candidate stands unconfirmed: the next poll confirms it.
    expect((await account.poll()).requests).toEqual(CONFIRMING)
    expect((await account.poll()).requests).toEqual(REUSED)
  })

  it('leaves the kept answer as it was when a poll that refused it is given up on', async () => {
    const account = new ReuseAccount()
    await confirm(account)
    account.explorer.tipHeight -= 1
    const listing = account.hold(path => path === FRESH_LISTING)
    const caller = new AbortController()
    const refused = account.start({ signal: caller.signal })
    await listing.arrived
    caller.abort(new Error('closed'))
    await expect(refused.answer).rejects.toThrow('closed')
    listing.release()

    account.explorer.tipHeight += 1
    expect((await account.poll()).requests).toEqual(REUSED)
  })

  it('never reuses an answer that a read of a changed listing replaced while the poll waited for the send guard', async () => {
    const account = new ReuseAccount()
    const reward = account.pay(5_000_000, { depth: 11, coinbase: true })
    const total = sum(account.payments)
    await confirm(account)

    // The poll takes the confirmed answer and waits for the send guard.
    const guard = holdGuard(account)
    const waiting = account.start({ readReserved: guard.readReserved })
    await guard.asked
    // A reorganisation at the same height swaps the reward for a payment of
    // the same value, and the tip falls a block: another read does not
    // reuse, reads the listing, and keeps it as a candidate in place of the
    // answer the poll took.
    account.explorer.removeTx(reward.txid)
    account.pay(5_000_000, { depth: 11 })
    account.explorer.tipHeight -= 1
    const other = await account.poll({ advance: 0 })
    expect(other.requests.slice(0, 3)).toEqual(LISTED_LATE)
    expect(other.value).toEqual(split({ available: total }))

    guard.answer()
    // The poll reads the listing too, rather than reuse the answer replaced.
    expect(await waiting.answer).toEqual(split({ available: total }))
    expect(waiting.requests().filter(path => path === FRESH_LISTING)).toHaveLength(2)
  })

  for (const waitsFor of ['tip', 'send guard'] as const) {
    it(`reads the listing at once, and keeps nothing, when the answers are cleared while a reusing poll waits for the ${waitsFor}`, async () => {
      // The wait for the tip does not run out here.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const account = new ReuseAccount()
      await confirm(account)
      const guardHeld = waitsFor === 'send guard'
      const guard = holdGuard(account)
      const requestsAtGuard: string[][] = []
      const from = account.sent.length
      const options: PollOptions = {
        readReserved: () => {
          requestsAtGuard.push(account.sent.slice(from))
          return guardHeld ? guard.readReserved() : Promise.resolve(new Set<string>())
        },
      }
      const tip = account.hold(path => path === TIP)
      const read = account.start(options)
      await tip.arrived
      if (guardHeld) {
        tip.release()
        await guard.asked
      }
      // A lock and an unlock.
      account.reuse.clear()
      tip.release()
      guard.answer()

      const value = await read.answer
      expect(read.requests()).toEqual(FORGOTTEN)
      expect(value).toEqual(await account.fresh())
      // The listing is asked for before the send guard is read when the clear
      // came first, and the guard read again after it when it came later.
      expect(requestsAtGuard).toEqual(guardHeld ? [REUSED, FORGOTTEN] : [FORGOTTEN])
      // Nothing kept: a candidate first, as from nothing.
      expect((await account.poll()).requests).toEqual(LISTED)
      expect((await account.poll()).requests).toEqual(CONFIRMING)
      expect((await account.poll()).requests).toEqual(REUSED)
    })
  }

  it('reads the listing when the tip is not a safe integer, and sets the answer aside', async () => {
    const account = new ReuseAccount()
    await confirm(account)
    // An integer, which the client takes, but not a safe one.
    account.explorer.tipHeight = Number.MAX_SAFE_INTEGER + 3
    const read = await account.poll()
    expect(read.requests.slice(0, 3)).toEqual(SET_ASIDE)
    expect(read.value).toEqual(await account.fresh())
  })
})

describe('answers of several addresses through one client (W-F3)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Whether a poll of `of` (the account's address by default) asked for its listing. */
  const listedFor = async (
    account: ReuseAccount,
    of?: { address: string; script: string }
  ): Promise<boolean> =>
    listed(
      (await account.poll(of ? { address: of.address, p2mrScriptPubKey: of.script } : {})).requests
    )

  it('keeps the answers of the two addresses most recently kept or reused, so a switch back reuses', async () => {
    const account = new ReuseAccount()
    const second = account.addAccount('cc')
    const third = account.addAccount('dd')
    const polls = async (of?: { address: string; script: string }): Promise<boolean[]> => [
      await listedFor(account, of),
      await listedFor(account, of),
      await listedFor(account, of),
    ]
    expect(await polls()).toEqual([true, true, false])
    expect(await polls(second)).toEqual([true, true, false])
    // Back to the first: still kept.
    expect(await listedFor(account)).toBe(false)
    // The first was reused last: the third's candidate pushes the second out.
    expect(await listedFor(account, third)).toBe(true)
    expect(await listedFor(account)).toBe(false)
    expect(await listedFor(account, second)).toBe(true)
  })

  it('counts an answer used only once a poll reuses it, not when a poll finds it and reads the listing after all', async () => {
    const account = new ReuseAccount()
    const second = account.addAccount('cc')
    const third = account.addAccount('dd')
    await confirm(account)
    expect(await listedFor(account, second)).toBe(true)
    expect(await listedFor(account, second)).toBe(true)

    // A poll of the first whose tip does not answer: it reads the listing
    // after all, and keeps nothing.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tip = account.hold(path => path === TIP)
    const read = account.start()
    await tip.arrived
    await settledAfter(read.answer)
    expect(read.requests().slice(0, 3)).toEqual(SET_ASIDE)
    tip.release()
    vi.useRealTimers()

    // The second was kept since: the third's candidate pushes the first out, not the second.
    expect(await listedFor(account, third)).toBe(true)
    expect(await listedFor(account, second)).toBe(false)
    expect(await listedFor(account)).toBe(true)
  })
})

describe('the store of kept answers (W-F3)', () => {
  const answer = {
    stats: '[]',
    facts: undefined,
    tipHeight: 2_000,
    spendable: [],
    immature: [],
  }

  it('works out nothing of a read that may not change what is kept: one begun before it was kept', () => {
    const reuse = new QbitBalanceReuse({ now: () => 0, wallNow: () => 0 })
    const client = {}
    const earlier = reuse.begin()
    const keeper = reuse.begin()
    keeper.keep(client, address, false, () => ({ answer, listingDigest: 'a' }))
    const found = vi.fn(() => ({ answer, listingDigest: 'a' }))
    earlier.keep(client, address, true, found)
    expect(found).not.toHaveBeenCalled()
    // One begun after it was kept compares its own.
    reuse.begin().keep(client, address, true, found)
    expect(found).toHaveBeenCalledTimes(1)
  })

  it('holds an answer for its client and address, whatever it is, until it is forgotten or cleared', () => {
    let time = 0
    const reuse = new QbitBalanceReuse({ now: () => time, wallNow: () => time })
    const client = {}
    const listing = { answer, listingDigest: 'a' }
    const keep = (found: QbitKeptListing | undefined): void =>
      reuse.begin().keep(client, address, true, () => found)
    const held: boolean[] = []
    const note = (): void => {
      held.push(reuse.holds(client, address))
    }
    note()
    // A candidate, confirmed, then forgotten by a listing that may not be kept.
    keep(listing)
    note()
    keep(listing)
    note()
    keep(undefined)
    note()
    // Confirmed again, set aside, then past its age: held until a clear.
    keep(listing)
    keep(listing)
    const view = reuse.begin()
    view.setAside(view.reusable(client, address, undefined)!)
    note()
    time += QBIT_BALANCE_REUSE_MAX_AGE_MS + 1
    note()
    expect(reuse.holds({}, address)).toBe(false)
    expect(reuse.holds(client, OTHER_ADDRESS)).toBe(false)
    reuse.clear()
    note()
    expect(held).toEqual([false, true, true, false, true, true, false])
  })
})

describe('a kept fact replaced by one that differs (W-F3)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * An account with a reward 11 blocks deep whose transaction the explorer
   * answered as a payment, so the kept answer, confirmed and reused, counts
   * it Available; the explorer answers right from then on.
   */
  async function wronglyReused() {
    const account = new ReuseAccount()
    const reward = account.pay(5_000_000, { depth: 11, coinbase: true })
    const answerRight = account.answerAsPayment(reward)
    const total = sum(account.payments)
    await confirm(account)
    const reused = await account.poll()
    expect(reused.requests).toEqual(REUSED)
    expect(reused.value).toEqual(split({ available: total }))
    answerRight()
    return {
      account,
      total,
      corrected: split({ available: total - 5_000_000, immature: 5_000_000 }),
    }
  }

  it('lists on the next poll once a read of outputs for a send replaced the fact, and shows what it left', async () => {
    const { account, corrected } = await wronglyReused()

    await account.readOutputs()

    const read = await account.poll()
    expect(read.requests.slice(0, 3)).toEqual(LISTED)
    expect(read.value).toEqual(corrected)
    expect(read.value).toEqual(await account.fresh())
  })

  for (const waitsFor of ['tip', 'send guard'] as const) {
    it(`reads the listing rather than reuse when the fact is replaced while the poll waits for the ${waitsFor}, and the next poll confirms what it listed`, async () => {
      const { account, corrected } = await wronglyReused()
      // The wait for the tip does not run out here.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const guard = holdGuard(account)
      const tip = waitsFor === 'tip' ? account.hold(path => path === TIP) : undefined
      const read = account.start({ readReserved: guard.readReserved })
      if (tip) await tip.arrived
      else await guard.asked

      // The read of outputs asks for the same tip, so it is waited for only
      // until it has replaced the fact.
      const outputs = account.readOutputs()
      await until(() => account.fundingTxReads.factChanges(account.client) === 1)
      tip?.release()
      guard.answer()
      await settledAfter(outputs)
      await settledAfter(read.answer)

      expect(await read.answer).toEqual(corrected)
      // Its own listing, not asked for fresh, besides the one the read of
      // outputs made: the answer was forgotten.
      expect(read.requests().slice(0, 2)).toEqual(REUSED)
      expect(read.requests().filter(path => path === LISTING)).toHaveLength(2)
      expect(read.requests()).not.toContain(FRESH_LISTING)

      // The count was taken again before that listing: what it listed is a
      // candidate, which the next poll's listing, asked for fresh, confirms.
      const next = await account.poll()
      expect(next.requests).toEqual(CONFIRMING)
      expect(next.value).toEqual(corrected)
      const reused = await account.poll()
      expect(reused.requests).toEqual(REUSED)
      expect(reused.value).toEqual(corrected)
    })
  }

  it('asks for the listing fresh when the answer ages out as the fact is replaced during the poll, and the next poll confirms what it listed', async () => {
    const { account, corrected } = await wronglyReused()
    const guard = holdGuard(account)
    const read = account.start({ readReserved: guard.readReserved })
    await guard.asked
    await account.readOutputs()
    expect(account.fundingTxReads.factChanges(account.client)).toBe(1)
    // The answer's age runs out too while the poll waits for the send guard:
    // too old, it is not forgotten, so the listing is asked for fresh.
    account.time += QBIT_BALANCE_REUSE_MAX_AGE_MS
    account.wallTime += QBIT_BALANCE_REUSE_MAX_AGE_MS
    guard.answer()
    expect(await read.answer).toEqual(corrected)
    expect(read.requests().slice(0, 2)).toEqual(REUSED)
    expect(read.requests()).toContain(FRESH_LISTING)

    // A candidate under the count taken again, which the next poll confirms.
    const next = await account.poll()
    expect(next.requests).toEqual(CONFIRMING)
    expect(next.value).toEqual(corrected)
    const reused = await account.poll()
    expect(reused.requests).toEqual(REUSED)
    expect(reused.value).toEqual(corrected)
  })

  for (const held of ['its listing', 'its second read of the send guard'] as const) {
    it(`keeps nothing from a poll that gave up a reuse when the fact is replaced while ${held} is held: the next poll lists as with nothing kept`, async () => {
      const { account, total, corrected } = await wronglyReused()
      const listing =
        held === 'its listing' ? account.hold(path => path === FRESH_LISTING) : undefined
      let arrive: () => void = () => undefined
      const arrived = new Promise<void>(resolve => (arrive = resolve))
      let release: () => void = () => undefined
      const released = new Promise<void>(resolve => (release = resolve))
      const readReserved = vi.fn(async (): Promise<ReadonlySet<string>> => {
        if (readReserved.mock.calls.length === 1) {
          // The answer's age runs out as the first read answers: the poll
          // reads the listing after all, asked for fresh, the count taken
          // again before it.
          account.time += QBIT_BALANCE_REUSE_MAX_AGE_MS
          account.wallTime += QBIT_BALANCE_REUSE_MAX_AGE_MS
        } else if (!listing) {
          arrive()
          await released
        }
        return account.reserved
      })
      const read = account.start({ readReserved })
      await (listing ? listing.arrived : arrived)

      // Replaced after the count was taken again: before the listing was
      // classified, or after.
      await account.readOutputs()
      expect(account.fundingTxReads.factChanges(account.client)).toBe(1)
      listing?.release()
      release()
      expect(await read.answer).toEqual(listing ? corrected : split({ available: total }))
      expect(read.requests().slice(0, 3)).toEqual([...REUSED, FRESH_LISTING])
      expect(readReserved).toHaveBeenCalledTimes(2)

      // The count moved while the read ran: it kept nothing, and forgot the
      // answer that had aged.
      expect(account.reuse.holds(account.client, address)).toBe(false)
      const next = await account.poll()
      expect(next.requests).toEqual(LISTED)
      expect(next.value).toEqual(corrected)
      expect(next.value).toEqual(await account.fresh())
    })
  }

  it('keeps nothing from a read during which the fact was replaced, and confirms no candidate kept before it', async () => {
    const account = new ReuseAccount()
    const reward = account.pay(5_000_000, { depth: 11, coinbase: true })
    const answerRight = account.answerAsPayment(reward)
    const total = sum(account.payments)
    const corrected = split({ available: total - 5_000_000, immature: 5_000_000 })
    expect((await account.poll()).requests).toEqual([...LISTED, `/tx/${reward.txid}`])

    // A read that would confirm the candidate classifies with the wrong fact,
    // and waits for the send guard while a read of outputs replaces it.
    answerRight()
    const guard = holdGuard(account)
    const during = account.start({ readReserved: guard.readReserved })
    await guard.asked
    await account.readOutputs()
    guard.answer()
    expect(await during.answer).toEqual(split({ available: total }))
    // It confirmed nothing, and forgot the candidate.
    const next = await account.poll()
    expect(next.requests).toEqual(LISTED)
    expect(next.value).toEqual(corrected)

    // A candidate kept before another replacement (back to the wrong fact)
    // is not confirmed after it: the next listing, asked for fresh, is a
    // candidate of its own, which the one after confirms.
    account.fundingTxReads.begin(account.client).keep(reward.txid, 0, {
      coinbase: false,
      value: 5_000_000,
      script,
    })
    expect(account.fundingTxReads.factChanges(account.client)).toBe(2)
    expect((await account.poll()).requests).toEqual(CONFIRMING)
    expect((await account.poll()).requests).toEqual(CONFIRMING)
    expect((await account.poll()).requests).toEqual(REUSED)
  })

  it('leaves the answer reused after a read of outputs for a send that replaced no fact with a differing one', async () => {
    const account = new ReuseAccount({ young: 3 })
    await confirm(account)
    expect((await account.poll()).requests).toEqual(REUSED)

    // It reads the young outputs' transactions again, and keeps the same facts.
    const sent = account.sent.length
    await account.readOutputs()
    expect(txReads(account.sent.slice(sent))).toEqual(
      expect.arrayContaining(account.payments.slice(-3).map(tx => tx.txid))
    )
    expect(account.fundingTxReads.factChanges(account.client)).toBe(0)

    const read = await account.poll()
    expect(read.requests).toEqual(REUSED)
    expect(read.value).toEqual(await account.fresh())
  })

  it('counts each kept fact replaced by one that differs, dropped or cleared, per client, and never goes back', () => {
    const reads = new QbitFundingTxReads({ maxOutpoints: 3 })
    const client = {}
    const other = {}
    const view = reads.begin(client)
    const txid = 'ab'.repeat(32)
    const facts = { coinbase: false, value: 1_000, script }
    const counts: number[] = []
    const count = (): void => {
      counts.push(reads.factChanges(client))
    }
    view.keep(txid, 0, facts)
    count()
    // The same facts, and the same script in other letters: no change.
    view.keep(txid, 0, { ...facts })
    view.keep(txid, 0, { ...facts, script: script.toUpperCase() })
    count()
    view.keep(txid, 0, { ...facts, coinbase: true })
    count()
    view.keep(txid, 0, { ...facts, coinbase: true, value: 2_000 })
    count()
    view.keep(txid, 0, { ...facts, coinbase: true, value: 2_000, script: FOREIGN_SCRIPT })
    count()
    // Kept new for another output and another client: no change.
    view.keep(txid, 1, facts)
    reads.begin(other).keep(txid, 0, facts)
    counts.push(reads.factChanges(client), reads.factChanges(other))
    // Forgotten: a change.
    view.forget(txid)
    count()
    // Past the bound of 3 outputs the least recently used go: the other
    // client's transaction, then the first of these.
    for (const seed of [1, 2, 3, 4]) view.keep(fakeTxid(seed, 88), 0, facts)
    counts.push(reads.factChanges(client), reads.factChanges(other))
    // A clear moves every client's count on, never back.
    reads.clear()
    counts.push(reads.factChanges(client), reads.factChanges(other))
    expect(counts).toEqual([0, 0, 1, 2, 3, 3, 0, 4, 5, 1, 6, 2])
  })

  for (const [how, maxOutpoints, drop] of [
    [
      "pushed out by another account's read of outputs for a send",
      1_000,
      async (account: ReuseAccount): Promise<void> => {
        // Payments younger than a coinbase maturity, none a reward: a read of
        // outputs for a send reads each one's transaction and keeps its fact,
        // 1,100 of them past the reader's bound of 1,000.
        const other = account.addAccount('ee', 1_100, 500)
        await readQbitAddressUtxos(account.client, other.address, {
          fundingTxReads: account.fundingTxReads,
        })
      },
    ],
    [
      'dropped by a read that found it disagree with the listed value',
      undefined,
      async (account: ReuseAccount): Promise<void> => {
        const reward = account.payments.at(-1)!
        await account.serveListing(listing =>
          listing.map(utxo =>
            utxo.txid === reward.txid ? { ...utxo, value: utxo.value + 1 } : utxo
          )
        )
        // A balance read without reuse is served the kept fact: its value disagrees.
        await getQbitSpendableBalanceV2(
          account.client,
          address,
          script,
          account.readReserved,
          undefined,
          {
            fundingTxReads: account.fundingTxReads,
          }
        ).catch(() => undefined)
        account.explorer.failures.length = 0
      },
    ],
  ] as const) {
    it(`lists, and shows the reward immature, once the wrong fact was ${how} and a read of outputs keeps the right one anew`, async () => {
      const account = new ReuseAccount(maxOutpoints === undefined ? {} : { maxOutpoints })
      const reward = account.pay(5_000_000, { depth: 11, coinbase: true })
      const answerRight = account.answerAsPayment(reward)
      const total = sum(account.payments)
      await confirm(account)
      const reused = await account.poll()
      expect(reused.requests).toEqual(REUSED)
      expect(reused.value).toEqual(split({ available: total }))

      answerRight()
      const before = account.fundingTxReads.factChanges(account.client)
      await drop(account)
      expect(account.fundingTxReads.begin(account.client).has(reward.txid, 0)).toBe(false)
      // The drop itself moved the count: the read of outputs after it can
      // push facts out too.
      expect(account.fundingTxReads.factChanges(account.client)).toBeGreaterThan(before)
      await account.readOutputs()

      const read = await account.poll()
      expect(read.requests.slice(0, 3)).toEqual(LISTED)
      expect(read.value).toEqual(split({ available: total - 5_000_000, immature: 5_000_000 }))
      expect(read.value).toEqual(await account.fresh())
    })
  }

  for (const [kind, value, coinbase] of [
    ['a payment', 4_000_000, false],
    ['a young reward', 5_000_000, true],
  ] as const) {
    it(`keeps nothing classified from an answer naming another script for ${kind}, so the poll after a read of outputs keeps the right fact shows what a fresh read does`, async () => {
      const account = new ReuseAccount()
      const paid = account.pay(value, { depth: 11, coinbase })
      const answerRight = account.answerWithScript(paid, FOREIGN_SCRIPT)
      const total = sum(account.payments)
      // The output counts as another script's: Unavailable, neither immature nor pending.
      const wrong = {
        ...split({ available: total - value }),
        unavailableBalance: value,
        totalBalance: total,
      }
      // Two reads in a row are answered so; the reader keeps no such fact.
      for (let read = 0; read < 2; read += 1) {
        const poll = await account.poll()
        expect(poll.requests).toEqual([...LISTED, `/tx/${paid.txid}`])
        expect(poll.value).toEqual(wrong)
      }
      expect(account.reuse.holds(account.client, address)).toBe(false)

      // A read of outputs keeps the right fact, new: no count moves.
      answerRight()
      await account.readOutputs()
      expect(account.fundingTxReads.factChanges(account.client)).toBe(0)

      const read = await account.poll()
      expect(read.requests).toEqual(LISTED)
      expect(read.value).toEqual(
        split(coinbase ? { available: total - value, immature: value } : { available: total })
      )
      expect(read.value).toEqual(await account.fresh())
    })
  }

  it('reuses nothing after a clear of the shared reader alone, though no fact changed since', async () => {
    const account = new ReuseAccount()
    await confirm(account)
    expect((await account.poll()).requests).toEqual(REUSED)
    // The reader cleared without the kept answers, which the controller never does.
    account.fundingTxReads.clear()
    expect((await account.poll()).requests.slice(0, 3)).toEqual(LISTED)
  })

  it('keeps nothing from a read during which a kept fact was replaced, when nothing was kept before it: the next poll lists as with nothing kept', async () => {
    const account = new ReuseAccount()
    const reward = account.pay(5_000_000, { depth: 11, coinbase: true })
    const answerRight = account.answerAsPayment(reward)
    const total = sum(account.payments)
    // The first read classifies the reward from the wrong answer, and waits
    // for the send guard while a read of outputs replaces the fact.
    const guard = holdGuard(account)
    const first = account.start({ readReserved: guard.readReserved })
    await guard.asked
    answerRight()
    await account.readOutputs()
    expect(account.fundingTxReads.factChanges(account.client)).toBe(1)
    guard.answer()
    expect(await first.answer).toEqual(split({ available: total }))

    const next = await account.poll()
    expect(next.requests.slice(0, 3)).toEqual(LISTED)
    expect(next.value).toEqual(split({ available: total - 5_000_000, immature: 5_000_000 }))
  })
})

describe('a tip that fails or is slow, poll after poll (W-F3)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads as with nothing kept until the answer would have aged once the tip failed, then forgets it, each answer what a read with nothing kept gives', async () => {
    const account = new ReuseAccount()
    await confirm(account)
    // Confirmed by the read that began at 20 s: its age runs out past 320 s.
    expect(account.time).toBe(2 * POLL_MS)
    account.explorer.failures.push(({ path }) =>
      path === TIP ? { status: 404, body: 'not found' } : undefined
    )
    const seen: string[][] = []
    const check = async (options: PollOptions = {}): Promise<void> => {
      const read = await account.poll(options)
      seen.push(read.requests.slice(0, 3))
      expect(read.value).toEqual(await account.fresh())
    }
    await check()
    await check()
    await check({ advance: 320_000 - account.time })
    // The age has run out: the listing is asked for fresh, and a listing
    // read with no tip height forgets the answer.
    await check({ advance: 1 })
    await check()
    // The tip back: read afresh, as from nothing kept.
    account.explorer.failures.length = 0
    await check()
    await check()
    await check()
    expect(seen).toEqual([
      SET_ASIDE,
      LISTED,
      LISTED,
      CONFIRMING,
      LISTED,
      LISTED,
      CONFIRMING,
      REUSED,
    ])
  })

  it('asks for the listing with the statistics, not after them, while the answer is set aside', async () => {
    const account = new ReuseAccount()
    await confirm(account)
    account.explorer.failures.push(({ path }) =>
      path === TIP ? { status: 404, body: 'not found' } : undefined
    )
    expect((await account.poll()).requests.slice(0, 3)).toEqual(SET_ASIDE)
    account.explorer.failures.length = 0

    for (let poll = 0; poll < 2; poll += 1) {
      const statistics = account.hold(path => path === STATS)
      const read = account.start()
      await statistics.arrived
      await vi.waitFor(() => expect(read.requests()).toContain(LISTING))
      statistics.release()
      const value = await read.answer
      expect(read.requests()).toEqual(LISTED)
      expect(value).toEqual(await account.fresh())
    }
  })

  it('costs one late poll an age at most when the tip answers after the wait every time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const account = new ReuseAccount()
    // The tip answers 1.5 s after it is asked, the listing 2 s.
    account.tip = 1.5 * QBIT_BALANCE_REUSE_TIP_WAIT_MS
    account.listingDelayMs = 2 * QBIT_BALANCE_REUSE_TIP_WAIT_MS
    const step = 100
    const nothingKept = await settledAfter(account.fresh(), step)
    const expected = split({ available: sum(account.payments) })
    const late: number[] = []
    const patterns: string[] = []
    const name = (requests: string[]): string =>
      [
        [LISTED, 'L'],
        [CONFIRMING, 'C'],
        [REUSED, 'R'],
        [SET_ASIDE, 'S'],
      ].find(
        ([pattern]) => (pattern as string[]).join() === requests.slice(0, 3).join()
      )?.[1] as string
    for (let poll = 1; poll <= 66; poll += 1) {
      const { answer, requests } = account.start()
      const ms = await settledAfter(answer, step)
      expect(await answer).toEqual(expected)
      patterns.push(name(requests()) ?? requests().slice(0, 3).join())
      if (ms > nothingKept + step) late.push(poll)
    }
    // Late only where it found the answer reusable and the tip did not
    // answer in time: once an age, 31 polls apart.
    expect(late).toEqual([3, 34, 65])
    expect(patterns.slice(0, 5).join('')).toBe('LCSLL')
    expect(patterns.slice(30, 36).join('')).toBe('LLCSLL')
  })

  it('forgets a candidate once a listing read for it has no tip height, so polls ask for the listing as with nothing kept', async () => {
    const account = new ReuseAccount()
    expect((await account.poll()).requests).toEqual(LISTED)
    account.explorer.failures.push(({ path }) =>
      path === TIP ? { status: 404, body: 'not found' } : undefined
    )
    const seen: string[][] = []
    for (let poll = 0; poll < 3; poll += 1) {
      const read = await account.poll()
      seen.push(read.requests.slice(0, 3))
      expect(read.value).toEqual(await account.fresh())
    }
    expect(seen).toEqual([CONFIRMING, LISTED, LISTED])
  })

  it('confirms nothing with a listing asked for while the answer was set aside, though its age ran out before the read kept it', async () => {
    const account = new ReuseAccount()
    await confirm(account)
    account.explorer.failures.push(({ path }) =>
      path === TIP ? { status: 404, body: 'not found' } : undefined
    )
    expect((await account.poll()).requests.slice(0, 3)).toEqual(SET_ASIDE)
    account.explorer.failures.length = 0

    // Just before the age runs out (past 320 s): asked for as with nothing
    // kept, and kept once it has run out.
    const listing = account.hold(path => path === LISTING)
    const read = account.start({ advance: 320_000 - account.time })
    await listing.arrived
    account.time += 1
    account.wallTime += 1
    listing.release()
    expect(read.requests().slice(0, 3)).toEqual(LISTED)
    expect(await read.answer).toEqual(await account.fresh())

    // The answer aged out unconfirmed: the next listing, fresh, confirms it.
    expect((await account.poll()).requests).toEqual(CONFIRMING)
    expect((await account.poll()).requests).toEqual(REUSED)
  })
})

describe('what a reused answer is compared by (W-F3)', () => {
  it('keeps and reuses nothing through a client that does not ask for a read fresh', async () => {
    const account = new ReuseAccount()
    const client = new EsploraClient({
      baseUrl: 'https://explorer.test/api',
      fetchFn: account.fetch as typeof fetch,
      retryBaseDelayMs: 0,
    })
    for (let poll = 0; poll < 4; poll += 1) {
      const read = await account.poll({}, client)
      expect(read.requests).toEqual(LISTED)
      expect(read.value).toEqual(split({ available: sum(account.payments) }))
    }
  })

  it('confirms with a listing that names the same outputs in another order and letter case', async () => {
    const account = new ReuseAccount()
    expect((await account.poll()).requests).toEqual(LISTED)
    await account.serveListing(listing =>
      [...listing].reverse().map(utxo => ({ ...utxo, txid: utxo.txid.toUpperCase() }))
    )
    expect((await account.poll()).requests).toEqual(CONFIRMING)
    const reused = await account.poll()
    expect(reused.requests).toEqual(REUSED)
    expect(reused.value).toEqual(await account.fresh())
  })

  it("keeps and reuses an answer whose transaction names the address's own script in upper case, as the split counts it the account's", async () => {
    const account = new ReuseAccount()
    const payment = account.pay(4_000_000, { depth: 11 })
    account.answerWithScript(payment, script.toUpperCase())
    expect((await account.poll()).requests).toEqual([...LISTED, `/tx/${payment.txid}`])
    expect((await account.poll()).requests).toEqual(CONFIRMING)
    const reused = await account.poll()
    expect(reused.requests).toEqual(REUSED)
    expect(reused.value).toEqual(split({ available: sum(account.payments) }))
    expect(reused.value).toEqual(await account.fresh())
  })

  it('never reuses an answer that another, confirmed in its place while the poll waited for the send guard, replaced', async () => {
    const account = new ReuseAccount()
    const reward = account.pay(5_000_000, { depth: 11, coinbase: true })
    const total = sum(account.payments)
    await confirm(account)
    // The poll takes the confirmed answer, the reward immature, and waits for the send guard.
    const guard = holdGuard(account)
    const waiting = account.start({ readReserved: guard.readReserved })
    await guard.asked
    // A reorganisation at the same height swaps the reward for a payment of
    // the same value, and the tip falls a block: two reads list it, the
    // second confirming it in place of the answer the poll took.
    account.explorer.removeTx(reward.txid)
    account.pay(5_000_000, { depth: 11 })
    account.explorer.tipHeight -= 1
    expect((await account.poll({ advance: 0 })).requests.slice(0, 3)).toEqual(LISTED_LATE)
    expect((await account.poll({ advance: 0 })).requests.slice(0, 3)).toEqual(CONFIRMING)

    guard.answer()
    const value = await waiting.answer
    expect(value).toEqual(split({ available: total }))
    expect(value).toEqual(await account.fresh())
  })
})

describe('an account past the listing limit (W-F3)', () => {
  it('makes the requests and gets the answers it did, with or without answers kept for reuse', async () => {
    const outcomes = async (withReuse: boolean) => {
      const account = new ReuseAccount()
      account.explorer.utxoLimit = 500
      // A read of the history found these outputs under the statistics as they read now.
      const outputs: QbitReadOutput[] = account.payments.map(tx => ({
        txid: tx.txid,
        vout: 0,
        satoshis: tx.outputs[0]!.value,
        scriptPk: script,
      }))
      const snapshot = qbitStatsSnapshot(account.explorer.stats(address))
      const readOutputs = (stats: string) => (stats === snapshot ? { outputs } : undefined)
      const polls: { value: unknown; requests: string[] }[] = []
      for (let poll = 0; poll < 4; poll += 1) {
        account.time += POLL_MS
        const from = account.sent.length
        const value = await getQbitSpendableBalanceV2(
          account.client,
          address,
          script,
          account.readReserved,
          poll < 2 ? undefined : readOutputs,
          {
            fundingTxReads: account.fundingTxReads,
            ...(withReuse ? { reuse: account.reuse.begin() } : {}),
          }
        )
        polls.push({ value, requests: account.sent.slice(from) })
      }
      return polls
    }

    const reusing = await outcomes(true)
    expect(reusing).toEqual(await outcomes(false))
    expect(reusing[0]!.requests).toEqual([...LISTED, STATS])
    expect(reusing[0]!.value).toMatchObject({ availableBalance: null, utxoLimitExceeded: true })
    expect(reusing[3]!.value).toMatchObject({
      availableBalance: 1_200 * 10_000 + (1_200 * 1_199) / 2,
      utxoLimitExceeded: true,
    })
  })
})

/** The read's outcome, once it has one, without awaiting it. */
function track<T>(promise: Promise<T>) {
  const outcome: { settled: boolean; value?: T; error?: unknown } = { settled: false }
  promise.then(
    value => Object.assign(outcome, { settled: true, value }),
    error => Object.assign(outcome, { settled: true, error })
  )
  return outcome
}

/** Wait, turn by turn, until `ready()` holds. */
async function until(ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < 10_000 && !ready(); turn += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
  expect(ready()).toBe(true)
}

/** The step the fake timers move by in `settledAfter`. */
const STEP_MS = 10

/** Move the fake timers on in steps of `step` ms until `promise` settles: the ms that took. */
async function settledAfter(promise: Promise<unknown>, step = STEP_MS): Promise<number> {
  const outcome = track(promise)
  let ms = 0
  while (ms < 60_000) {
    // What the explorer and the read do between timers.
    for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setImmediate(resolve))
    if (outcome.settled) break
    await vi.advanceTimersByTimeAsync(step)
    ms += step
  }
  return ms
}
