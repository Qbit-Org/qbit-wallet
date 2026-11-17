import { describe, expect, it } from 'vitest'

import { ChainType } from '@qbit/wallet-types'
import {
  QBIT_ACCOUNT_TOTALS_MAX_READS_IN_FLIGHT,
  QBIT_ACCOUNT_TOTAL_FRESH_MS,
  QBIT_ACCOUNT_TOTAL_READ_DEADLINE_MS,
  QBIT_ACCOUNT_TOTAL_RETRY_AFTER_MS,
  QBIT_ACCOUNT_TOTAL_SETTLING_FRESH_MS,
  QBIT_ACCOUNT_TOTAL_SETTLING_MS,
  QbitAccountTotals,
  type QbitAccountTotalReadOptions,
  type QbitAccountTotalsClient,
} from '../src/utils/qbit-account-totals'

const CHAIN = ChainType.QBIT_TESTNET4
const ADDRESS = 'tq1account0'

interface PendingCall {
  address: string
  options: QbitAccountTotalReadOptions
  /** The fake clock when the call was made. */
  at: number
  answer(totalSats: unknown): void
  fail(error?: unknown): void
}

/**
 * A statistics read per call, each answered or failed by the test. It
 * ignores the signal, as a request slow to stop would: only the totals'
 * own handling of an abort frees the slot.
 */
class FakeTotalsClient implements QbitAccountTotalsClient {
  readonly calls: PendingCall[] = []
  inFlight = 0
  maxInFlight = 0

  constructor(private readonly clock: { now: number }) {}

  getAddressBalance(
    address: string,
    options: QbitAccountTotalReadOptions
  ): Promise<{ totalSats: number }> {
    this.inFlight += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (): boolean => {
        if (settled) return false
        settled = true
        this.inFlight -= 1
        return true
      }
      this.calls.push({
        address,
        options,
        at: this.clock.now,
        answer: totalSats => {
          if (settle()) resolve({ totalSats } as { totalSats: number })
        },
        fail: (error = new Error('explorer down')) => {
          if (settle()) reject(error)
        },
      })
    })
  }

  /** Calls not yet answered, for `address` when given. */
  pending(address?: string): PendingCall[] {
    return this.calls.filter(call => address === undefined || call.address === address)
  }
}

/** Let every settled promise's continuations run. */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function setup() {
  const clock = { now: 1_800_000_000_000 }
  const lock = { unlocked: true }
  const totals = new QbitAccountTotals({ now: () => clock.now, usable: () => lock.unlocked })
  const client = new FakeTotalsClient(clock)
  return { clock, lock, totals, client }
}

const noTotal = (address = ADDRESS) => ({
  address,
  chainType: CHAIN,
  totalBalance: null,
  readAt: null,
  fresh: false,
  error: false,
})

describe('QbitAccountTotals', () => {
  it('has the documented bounds', () => {
    expect(QBIT_ACCOUNT_TOTAL_FRESH_MS).toBe(60_000)
    expect(QBIT_ACCOUNT_TOTAL_RETRY_AFTER_MS).toBe(10_000)
    expect(QBIT_ACCOUNT_TOTAL_SETTLING_MS).toBe(30_000)
    expect(QBIT_ACCOUNT_TOTAL_SETTLING_FRESH_MS).toBe(10_000)
    expect(QBIT_ACCOUNT_TOTALS_MAX_READS_IN_FLIGHT).toBe(4)
    expect(QBIT_ACCOUNT_TOTAL_READ_DEADLINE_MS).toBe(8_000)
  })

  it('answers from a total for 60 s after its answer arrived, then reads it again', async () => {
    const { clock, totals, client } = setup()
    expect(totals.peek(client, ADDRESS, CHAIN)).toEqual(noTotal())

    const first = totals.read(client, ADDRESS, CHAIN)
    // The answer arrives a while after the request.
    clock.now += 2_000
    const readAt = clock.now
    client.calls[0]!.answer(5_000)
    await expect(first).resolves.toEqual({
      address: ADDRESS,
      chainType: CHAIN,
      totalBalance: 5_000,
      readAt,
      fresh: true,
      error: false,
    })

    clock.now = readAt + QBIT_ACCOUNT_TOTAL_FRESH_MS - 1
    await expect(totals.read(client, ADDRESS, CHAIN)).resolves.toMatchObject({
      totalBalance: 5_000,
      fresh: true,
    })
    expect(client.calls).toHaveLength(1)

    clock.now = readAt + QBIT_ACCOUNT_TOTAL_FRESH_MS
    expect(totals.peek(client, ADDRESS, CHAIN)).toEqual({
      ...noTotal(),
      totalBalance: 5_000,
      readAt,
    })
    const again = totals.read(client, ADDRESS, CHAIN)
    await flush()
    expect(client.calls).toHaveLength(2)
    client.calls[1]!.answer(6_000)
    await expect(again).resolves.toMatchObject({ totalBalance: 6_000, fresh: true })
  })

  it('is never fresh without a total', async () => {
    const { totals, client } = setup()
    const read = totals.read(client, ADDRESS, CHAIN)
    expect(totals.peek(client, ADDRESS, CHAIN).fresh).toBe(false)
    client.calls[0]!.fail()
    await expect(read).resolves.toEqual({ ...noTotal(), error: true })
    expect(totals.peek(client, ADDRESS, CHAIN)).toEqual({ ...noTotal(), error: true })
  })

  it('makes one request for two concurrent reads of an address, and gives both its answer', async () => {
    const { totals, client } = setup()
    const one = totals.read(client, ADDRESS, CHAIN)
    const two = totals.read(client, ADDRESS, CHAIN)
    await flush()
    expect(client.calls).toHaveLength(1)

    client.calls[0]!.answer(7_000)
    const [a, b] = await Promise.all([one, two])
    expect(a).toEqual(b)
    expect(a).toMatchObject({ totalBalance: 7_000, fresh: true, error: false })
  })

  it('keeps at most four requests in flight per client, the rest first come first served, a failure freeing its slot', async () => {
    const { totals, client } = setup()
    const addresses = Array.from({ length: 9 }, (_, index) => `tq1account${index}`)
    const reads = addresses.map(address => totals.read(client, address, CHAIN))
    await flush()
    expect(client.calls.map(call => call.address)).toEqual(addresses.slice(0, 4))

    // A failure frees its slot to the next in line.
    client.pending('tq1account2')[0]!.fail()
    await flush()
    expect(client.calls.map(call => call.address)).toEqual(addresses.slice(0, 5))
    client.pending('tq1account0')[0]!.answer(1)
    client.pending('tq1account3')[0]!.answer(1)
    await flush()
    expect(client.calls.map(call => call.address)).toEqual(addresses.slice(0, 7))
    for (const call of client.calls) call.answer(1)
    await flush()
    expect(client.calls.map(call => call.address)).toEqual(addresses)
    expect(client.maxInFlight).toBe(4)

    for (const call of client.calls) call.answer(1)
    await Promise.all(reads)
    expect(client.inFlight).toBe(0)
    // Another client has slots of its own.
    const other = new FakeTotalsClient({ now: 0 })
    const more = addresses.map(address => totals.read(other, address, CHAIN))
    await flush()
    expect(other.calls).toHaveLength(4)
    for (let index = 0; index < 9; index += 1) {
      other.calls[index]!.answer(1)
      await flush()
    }
    await Promise.all(more)
  })

  it('hands the client the deadline when the slot is free, not when the read was asked for', async () => {
    const { clock, totals, client } = setup()
    const slots = QBIT_ACCOUNT_TOTALS_MAX_READS_IN_FLIGHT
    const addresses = Array.from({ length: slots + 1 }, (_, index) => `tq1account${index}`)
    const reads = addresses.map(address => totals.read(client, address, CHAIN))
    await flush()
    clock.now += 5_000
    client.calls[0]!.answer(1)
    await flush()

    expect(client.calls).toHaveLength(slots + 1)
    for (const call of client.calls) {
      // A fresh read, which a clear can abort.
      expect(call.options).toEqual({
        deadlineMs: QBIT_ACCOUNT_TOTAL_READ_DEADLINE_MS,
        signal: expect.any(AbortSignal),
        fresh: true,
      })
    }
    // The queued one is called only once a slot is free, so its whole
    // deadline is the call's own.
    expect(client.calls[slots]!.at - client.calls[0]!.at).toBe(5_000)
    for (const call of client.calls) call.answer(1)
    await Promise.all(reads)
  })

  describe('reads settling out of order', () => {
    it('keeps a later read of its own over an earlier balance read that settles after it', async () => {
      const { totals, client } = setup()
      const balanceSince = totals.begin()
      const read = totals.read(client, ADDRESS, CHAIN)
      client.calls[0]!.answer(2_000)
      await expect(read).resolves.toMatchObject({ totalBalance: 2_000 })

      totals.measured(client, ADDRESS, 1_000, balanceSince)
      expect(totals.peek(client, ADDRESS, CHAIN)).toMatchObject({
        totalBalance: 2_000,
        fresh: true,
      })
    })

    it('keeps a later balance read over an earlier read of its own that settles after it', async () => {
      const { totals, client } = setup()
      const read = totals.read(client, ADDRESS, CHAIN)
      await flush()
      totals.measured(client, ADDRESS, 3_000, totals.begin())

      client.calls[0]!.answer(1_000)
      // The caller hears what is kept: the later total.
      await expect(read).resolves.toMatchObject({ totalBalance: 3_000, fresh: true })
      expect(totals.peek(client, ADDRESS, CHAIN).totalBalance).toBe(3_000)
    })

    it('keeps the later of two balance reads, whatever order they settle in', () => {
      const { totals, client } = setup()
      const earlier = totals.begin()
      const later = totals.begin()
      totals.measured(client, ADDRESS, 9_000, later)
      totals.measured(client, ADDRESS, 8_000, earlier)
      expect(totals.peek(client, ADDRESS, CHAIN).totalBalance).toBe(9_000)
    })

    it('is not fresh while its latest read failed, even when an earlier-begun read succeeds after it', async () => {
      const { totals, client } = setup()
      const balance = totals.begin()
      const read = totals.read(client, ADDRESS, CHAIN)
      client.calls[0]!.fail()
      await expect(read).resolves.toEqual({ ...noTotal(), error: true })

      // The balance read began before the failed one: its total is newer than
      // anything kept, so it is kept, but the latest read still failed.
      totals.measured(client, ADDRESS, 3_000, balance)
      expect(totals.peek(client, ADDRESS, CHAIN)).toMatchObject({
        totalBalance: 3_000,
        fresh: false,
        error: true,
      })
    })

    it('ranks a read by when its request starts, not by when its caller began', async () => {
      const { totals, client } = setup()
      // The caller takes its place, then checks the address is its own.
      const caller = totals.begin()
      // Meanwhile a balance read begins and settles, and a broadcast follows.
      totals.measured(client, ADDRESS, 1_000, totals.begin())
      totals.invalidate(client)

      const read = totals.read(client, ADDRESS, CHAIN, caller)
      client.calls[0]!.answer(2_000)
      // Its request began after the balance read: its total is the newer one.
      await expect(read).resolves.toMatchObject({ totalBalance: 2_000, fresh: true })
    })

    it('records no failure from a read that began before a later success', async () => {
      const { totals, client } = setup()
      const read = totals.read(client, ADDRESS, CHAIN)
      await flush()
      totals.measured(client, ADDRESS, 3_000, totals.begin())
      client.calls[0]!.fail()
      await expect(read).resolves.toMatchObject({ totalBalance: 3_000, fresh: true, error: false })
    })
  })

  describe('a clear', () => {
    it('keeps nothing from a read in flight and gives its callers no total', async () => {
      const { totals, client } = setup()
      const one = totals.read(client, ADDRESS, CHAIN)
      const two = totals.read(client, ADDRESS, CHAIN)
      await flush()

      totals.clear()
      // A read after the clear does not join the one before it.
      const after = totals.read(client, ADDRESS, CHAIN)
      await flush()
      expect(client.calls).toHaveLength(2)

      client.calls[0]!.answer(4_000)
      await expect(one).resolves.toEqual(noTotal())
      await expect(two).resolves.toEqual(noTotal())
      expect(totals.peek(client, ADDRESS, CHAIN)).toEqual(noTotal())
      client.calls[1]!.answer(4_500)
      await expect(after).resolves.toMatchObject({ totalBalance: 4_500, fresh: true })
    })

    it('reads nothing for a call that began before it', async () => {
      const { totals, client } = setup()
      const since = totals.begin()
      totals.clear()
      await expect(totals.read(client, ADDRESS, CHAIN, since)).resolves.toEqual(noTotal())
      expect(client.calls).toHaveLength(0)
    })

    it('keeps nothing from a balance read that began before it', () => {
      const { totals, client } = setup()
      const since = totals.begin()
      totals.clear()
      totals.measured(client, ADDRESS, 1_000, since)
      expect(totals.peek(client, ADDRESS, CHAIN)).toEqual(noTotal())
    })

    it('forgets every kept total', async () => {
      const { totals, client } = setup()
      totals.measured(client, ADDRESS, 1_000, totals.begin())
      totals.clear()
      expect(totals.peek(client, ADDRESS, CHAIN)).toEqual(noTotal())
    })
  })

  describe('while the wallet reads locked', () => {
    it('keeps nothing a read settles with and gives its caller no total', async () => {
      const { lock, totals, client } = setup()
      const read = totals.read(client, ADDRESS, CHAIN)
      await flush()
      lock.unlocked = false
      client.calls[0]!.answer(1_000)
      await expect(read).resolves.toEqual(noTotal())
      lock.unlocked = true
      expect(totals.peek(client, ADDRESS, CHAIN)).toEqual(noTotal())
    })

    it('serves nothing and reads nothing', async () => {
      const { lock, totals, client } = setup()
      totals.measured(client, ADDRESS, 1_000, totals.begin())
      lock.unlocked = false
      expect(totals.peek(client, ADDRESS, CHAIN)).toEqual(noTotal())
      await expect(totals.read(client, ADDRESS, CHAIN)).resolves.toEqual(noTotal())
      totals.measured(client, 'tq1other', 2_000, totals.begin())
      expect(client.calls).toHaveLength(0)
      lock.unlocked = true
      expect(totals.peek(client, 'tq1other', CHAIN)).toEqual(noTotal('tq1other'))
    })
  })

  describe('an invalidation', () => {
    it("keeps every total of its client but none fresh, and leaves other clients' alone", async () => {
      const { clock, totals, client } = setup()
      const other = new FakeTotalsClient(clock)
      totals.measured(client, ADDRESS, 1_000, totals.begin())
      totals.measured(client, 'tq1other', 2_000, totals.begin())
      totals.measured(other, ADDRESS, 3_000, totals.begin())

      totals.invalidate(client)

      expect(totals.peek(client, ADDRESS, CHAIN)).toMatchObject({
        totalBalance: 1_000,
        fresh: false,
      })
      expect(totals.peek(client, 'tq1other', CHAIN)).toMatchObject({
        totalBalance: 2_000,
        fresh: false,
        error: false,
      })
      expect(totals.peek(other, ADDRESS, CHAIN)).toMatchObject({ totalBalance: 3_000, fresh: true })
      // Not fresh, so read again.
      const read = totals.read(client, ADDRESS, CHAIN)
      await flush()
      expect(client.calls).toHaveLength(1)
      client.calls[0]!.answer(900)
      await expect(read).resolves.toMatchObject({ totalBalance: 900, fresh: true })
    })

    it('keeps a read in flight across it, but not fresh', async () => {
      const { totals, client } = setup()
      const read = totals.read(client, ADDRESS, CHAIN)
      await flush()
      totals.invalidate(client)
      client.calls[0]!.answer(1_000)
      await expect(read).resolves.toMatchObject({ totalBalance: 1_000, fresh: false, error: false })
    })

    it('keeps nothing of a balance read that began before it, the kept total left not fresh, and keeps one begun 30 s after it, fresh', () => {
      const { clock, totals, client } = setup()
      totals.measured(client, ADDRESS, 900, totals.begin())
      const before = totals.begin()
      totals.invalidate(client)
      totals.measured(client, ADDRESS, 1_000, before)
      expect(totals.peek(client, ADDRESS, CHAIN)).toMatchObject({
        totalBalance: 900,
        fresh: false,
        error: false,
      })
      clock.now += QBIT_ACCOUNT_TOTAL_SETTLING_MS
      totals.measured(client, ADDRESS, 1_100, totals.begin())
      expect(totals.peek(client, ADDRESS, CHAIN)).toMatchObject({
        totalBalance: 1_100,
        fresh: true,
      })
    })

    it('starts a read of its own for a call made after it, rather than wait on one begun before it', async () => {
      const { totals, client } = setup()
      const before = totals.read(client, ADDRESS, CHAIN)
      await flush()
      totals.invalidate(client)

      const after = totals.read(client, ADDRESS, CHAIN)
      await flush()
      expect(client.calls).toHaveLength(2)
      client.calls[1]!.answer(1_100)
      // Answered by its own request, while the earlier one has not answered.
      await expect(after).resolves.toMatchObject({ totalBalance: 1_100, fresh: true })

      // The earlier read still settles for its own caller; its total, from
      // a read that began earlier, replaces nothing.
      client.calls[0]!.answer(1_000)
      await expect(before).resolves.toMatchObject({ totalBalance: 1_100 })
      expect(totals.peek(client, ADDRESS, CHAIN).totalBalance).toBe(1_100)
    })

    it('still shares a read begun after it', async () => {
      const { totals, client } = setup()
      totals.invalidate(client)
      const one = totals.read(client, ADDRESS, CHAIN)
      const two = totals.read(client, ADDRESS, CHAIN)
      await flush()
      expect(client.calls).toHaveLength(1)
      client.calls[0]!.answer(1_000)
      expect(await one).toEqual(await two)
    })
  })

  describe('a failed read', () => {
    it('keeps the last total with error, asks nothing for 10 s, then asks once', async () => {
      const { clock, totals, client } = setup()
      const first = totals.read(client, ADDRESS, CHAIN)
      client.calls[0]!.answer(5_000)
      const { readAt } = await first

      clock.now += QBIT_ACCOUNT_TOTAL_FRESH_MS
      const failing = totals.read(client, ADDRESS, CHAIN)
      await flush()
      client.calls[1]!.fail(new Error('deadline'))
      const failed = { ...noTotal(), totalBalance: 5_000, readAt, error: true }
      await expect(failing).resolves.toEqual(failed)

      clock.now += QBIT_ACCOUNT_TOTAL_RETRY_AFTER_MS - 1
      await expect(totals.read(client, ADDRESS, CHAIN)).resolves.toEqual(failed)
      await expect(totals.read(client, ADDRESS, CHAIN)).resolves.toEqual(failed)
      expect(client.calls).toHaveLength(2)

      clock.now += 1
      const retries = [totals.read(client, ADDRESS, CHAIN), totals.read(client, ADDRESS, CHAIN)]
      await flush()
      expect(client.calls).toHaveLength(3)
      client.calls[2]!.answer(5_500)
      for (const retry of await Promise.all(retries)) {
        expect(retry).toMatchObject({ totalBalance: 5_500, fresh: true, error: false })
      }
    })

    it('pauses after the failure of a read begun after the latest invalidation, until the next one', async () => {
      const { totals, client } = setup()
      totals.invalidate(client)
      const failing = totals.read(client, ADDRESS, CHAIN)
      await flush()
      client.calls[0]!.fail()
      await expect(failing).resolves.toEqual({ ...noTotal(), error: true })
      await expect(totals.read(client, ADDRESS, CHAIN)).resolves.toEqual({
        ...noTotal(),
        error: true,
      })
      expect(client.calls).toHaveLength(1)

      // Another submission: that failure says nothing of the explorer after it.
      totals.invalidate(client)
      const again = totals.read(client, ADDRESS, CHAIN)
      await flush()
      expect(client.calls).toHaveLength(2)
      client.calls[1]!.answer(1_000)
      await expect(again).resolves.toMatchObject({ totalBalance: 1_000, error: false })
    })

    it('does not pause after the failure of a read begun before the latest invalidation', async () => {
      const { clock, totals, client } = setup()
      const first = totals.read(client, ADDRESS, CHAIN)
      client.calls[0]!.answer(5_000)
      await first
      clock.now += QBIT_ACCOUNT_TOTAL_FRESH_MS
      // Read before the send, failed after it.
      const before = totals.read(client, ADDRESS, CHAIN)
      await flush()
      totals.invalidate(client)
      client.calls[1]!.fail()
      await expect(before).resolves.toMatchObject({ totalBalance: 5_000, error: true })

      // A call after the send reads, and is answered by its own request.
      const after = totals.read(client, ADDRESS, CHAIN)
      await flush()
      expect(client.calls).toHaveLength(3)
      client.calls[2]!.answer(5_500)
      await expect(after).resolves.toMatchObject({
        totalBalance: 5_500,
        fresh: true,
        error: false,
      })
    })

    it('does not pause after the failure of a read begun during a submission', async () => {
      const { totals, client } = setup()
      const settled = totals.submission(client)
      try {
        const during = totals.read(client, ADDRESS, CHAIN)
        await flush()
        client.calls[0]!.fail()
        await expect(during).resolves.toEqual({ ...noTotal(), error: true })

        const again = totals.read(client, ADDRESS, CHAIN)
        await flush()
        expect(client.calls).toHaveLength(2)
        client.calls[1]!.answer(1_200)
        await expect(again).resolves.toMatchObject({ totalBalance: 1_200, error: false })
      } finally {
        settled()
      }
    })

    it('never answers 0 for a total it did not measure', async () => {
      const { clock, totals, client } = setup()
      for (const [index, reply] of [undefined, null, -1, 1.5, Number.NaN, '7', 2 ** 53].entries()) {
        clock.now += QBIT_ACCOUNT_TOTAL_RETRY_AFTER_MS
        const read = totals.read(client, ADDRESS, CHAIN)
        await flush()
        client.calls[index]!.answer(reply)
        await expect(read).resolves.toEqual({ ...noTotal(), error: true })
      }
      const rejected = totals.read(client, 'tq1other', CHAIN)
      await flush()
      client.pending('tq1other')[0]!.fail()
      await expect(rejected).resolves.toEqual({ ...noTotal('tq1other'), error: true })
      // A balance read's figure that is not a measured total is not kept either.
      totals.measured(client, 'tq1third', Number.NaN, totals.begin())
      expect(totals.peek(client, 'tq1third', CHAIN)).toEqual(noTotal('tq1third'))
    })
  })
  describe('a clear, for reads begun before it', () => {
    it('sends nothing for those still waiting, cancels those in flight, and holds up no later read', async () => {
      const { totals, client } = setup()
      const before = Array.from({ length: 30 }, (_, index) =>
        totals.read(client, `tq1stale${index}`, CHAIN)
      )
      await flush()
      expect(client.calls).toHaveLength(QBIT_ACCOUNT_TOTALS_MAX_READS_IN_FLIGHT)

      totals.clear()
      for (const call of client.calls) expect(call.options.signal.aborted).toBe(true)
      const after = totals.read(client, 'tq1fresh', CHAIN)
      await flush()

      // The new read went out at once, though none of the cancelled requests
      // has answered; nothing else did.
      const slots = QBIT_ACCOUNT_TOTALS_MAX_READS_IN_FLIGHT
      expect(client.calls.map(call => call.address)).toEqual([
        ...Array.from({ length: slots }, (_, index) => `tq1stale${index}`),
        'tq1fresh',
      ])
      expect(client.calls[slots]!.options.signal.aborted).toBe(false)
      for (const answer of await Promise.all(before)) {
        expect(answer).toEqual(noTotal(answer.address))
      }
      // A cancelled request answering late changes nothing.
      for (const call of client.calls.slice(0, slots)) call.answer(1)
      await flush()
      expect(client.calls).toHaveLength(slots + 1)
      client.pending('tq1fresh')[0]!.answer(2)
      await expect(after).resolves.toMatchObject({ totalBalance: 2, fresh: true })
      expect(totals.peek(client, 'tq1stale0', CHAIN)).toEqual(noTotal('tq1stale0'))
    })
  })

  describe('a clear of the may-read-again kind', () => {
    it('lets the calls it overtook, and only those, read once more', async () => {
      const { totals, client } = setup()
      const overtaken = totals.begin()
      const reading = totals.read(client, ADDRESS, CHAIN, overtaken)
      await flush()
      totals.clear('may-read-again')
      await expect(reading).resolves.toEqual(noTotal())
      expect(totals.mayReadAgain(overtaken)).toBe(true)
      const later = totals.begin()
      expect(totals.mayReadAgain(later)).toBe(false)

      // Read again under a new place, as the usual rules have it.
      const again = totals.read(client, ADDRESS, CHAIN, later)
      await flush()
      client.calls[1]!.answer(1_000)
      await expect(again).resolves.toMatchObject({ totalBalance: 1_000, fresh: true })

      // A clear of the other kind overtakes both for good.
      totals.clear()
      expect(totals.mayReadAgain(overtaken)).toBe(false)
      expect(totals.mayReadAgain(later)).toBe(false)
      const last = totals.begin()
      totals.clear('may-read-again')
      expect(totals.mayReadAgain(last)).toBe(true)
      expect(totals.mayReadAgain(overtaken)).toBe(false)
    })

    it('is not the default', () => {
      const { totals } = setup()
      const overtaken = totals.begin()
      totals.clear()
      expect(totals.mayReadAgain(overtaken)).toBe(false)
    })
  })

  describe('after an invalidation, while the explorer may lag', () => {
    it('keeps a total read within 30 s of it fresh for 10 s only, and one read later for 60 s', async () => {
      const { clock, totals, client } = setup()
      totals.invalidate(client)
      clock.now += QBIT_ACCOUNT_TOTAL_SETTLING_MS - 1
      const early = totals.read(client, ADDRESS, CHAIN)
      clock.now += 1
      client.calls[0]!.answer(1_000)
      const { readAt } = await early
      expect(readAt).toBe(clock.now)

      clock.now = readAt! + QBIT_ACCOUNT_TOTAL_SETTLING_FRESH_MS - 1
      expect(totals.peek(client, ADDRESS, CHAIN).fresh).toBe(true)
      clock.now += 1
      expect(totals.peek(client, ADDRESS, CHAIN).fresh).toBe(false)

      // Begun 30 s after the invalidation: fresh for the full minute.
      const late = totals.read(client, ADDRESS, CHAIN)
      client.calls[1]!.answer(1_100)
      const settled = await late
      clock.now = settled.readAt! + QBIT_ACCOUNT_TOTAL_FRESH_MS - 1
      expect(totals.peek(client, ADDRESS, CHAIN)).toMatchObject({
        totalBalance: 1_100,
        fresh: true,
      })
    })

    it('keeps nothing of a total fed by a balance read begun within 30 s of it, and keeps one begun later, fresh for 60 s', async () => {
      const { clock, totals, client } = setup()
      totals.measured(client, ADDRESS, 900, totals.begin())
      totals.invalidate(client)
      const invalidatedAt = clock.now
      // Its request is no fresh read: it may have been answered from before.
      clock.now = invalidatedAt + QBIT_ACCOUNT_TOTAL_SETTLING_MS - 1
      totals.measured(client, ADDRESS, 1_000, totals.begin())
      expect(totals.peek(client, ADDRESS, CHAIN)).toMatchObject({
        totalBalance: 900,
        fresh: false,
        error: false,
      })
      expect(totals.peek(client, 'tq1other', CHAIN)).toEqual(noTotal('tq1other'))
      totals.measured(client, 'tq1other', 2_000, totals.begin())
      expect(totals.peek(client, 'tq1other', CHAIN)).toEqual(noTotal('tq1other'))
      // So a read of its own measures it afresh.
      const read = totals.read(client, ADDRESS, CHAIN)
      await flush()
      expect(client.calls).toHaveLength(1)
      client.calls[0]!.answer(1_050)
      await expect(read).resolves.toMatchObject({ totalBalance: 1_050, fresh: true })

      clock.now = invalidatedAt + QBIT_ACCOUNT_TOTAL_SETTLING_MS
      const balance = totals.begin()
      totals.measured(client, ADDRESS, 1_100, balance)
      clock.now = balance.at + QBIT_ACCOUNT_TOTAL_FRESH_MS - 1
      expect(totals.peek(client, ADDRESS, CHAIN)).toMatchObject({
        totalBalance: 1_100,
        fresh: true,
      })
    })

    it('counts a clock gone back since it as within 30 s for a fed total too', () => {
      const { clock, totals, client } = setup()
      totals.invalidate(client)
      clock.now -= 60_000
      totals.measured(client, ADDRESS, 1_000, totals.begin())
      expect(totals.peek(client, ADDRESS, CHAIN)).toEqual(noTotal())
    })

    it('never lets a fed total it keeps nothing of outrank a read of its own begun earlier', async () => {
      const { clock, totals, client } = setup()
      totals.measured(client, ADDRESS, 900, totals.begin())
      // A broadcast settles at t = 0.
      totals.invalidate(client)
      const sentAt = clock.now
      // The switcher's fresh read begins at t = 5 s.
      clock.now = sentAt + 5_000
      const read = totals.read(client, ADDRESS, CHAIN)
      await flush()
      expect(client.calls).toHaveLength(1)
      // The home poll begins at t = 6 s and settles at 6.5 s with an
      // HTTP-cached total from before the send.
      clock.now = sentAt + 6_000
      const poll = totals.begin()
      clock.now = sentAt + 6_500
      totals.measured(client, ADDRESS, 900, poll)
      // The switcher's read settles at t = 7 s with the total after it.
      clock.now = sentAt + 7_000
      client.calls[0]!.answer(1_900)
      await expect(read).resolves.toMatchObject({
        totalBalance: 1_900,
        readAt: clock.now,
        fresh: true,
        error: false,
      })
      expect(totals.peek(client, ADDRESS, CHAIN)).toMatchObject({
        totalBalance: 1_900,
        fresh: true,
      })
    })

    it('counts a clock gone back since the invalidation as within it', async () => {
      const { clock, totals, client } = setup()
      totals.invalidate(client)
      clock.now -= 60_000
      const read = totals.read(client, ADDRESS, CHAIN)
      client.calls[0]!.answer(1_000)
      const { readAt } = await read
      clock.now = readAt! + QBIT_ACCOUNT_TOTAL_SETTLING_FRESH_MS
      expect(totals.peek(client, ADDRESS, CHAIN).fresh).toBe(false)
    })
  })

  describe('a submission under way', () => {
    it('leaves every total read that settles during it kept but not fresh, and keeps nothing fed', async () => {
      const { clock, totals, client } = setup()
      totals.measured(client, ADDRESS, 1_000, totals.begin())
      const settled = totals.submission(client)
      // Not fresh from the moment it begins.
      expect(totals.peek(client, ADDRESS, CHAIN)).toMatchObject({
        totalBalance: 1_000,
        fresh: false,
      })

      // Read and settled while it is under way: kept, not fresh.
      const during = totals.read(client, ADDRESS, CHAIN)
      client.calls[0]!.answer(1_200)
      await expect(during).resolves.toMatchObject({ totalBalance: 1_200, fresh: false })
      // Fed while it is under way: not kept at all, however long it has been.
      totals.measured(client, 'tq1other', 2_000, totals.begin())
      expect(totals.peek(client, 'tq1other', CHAIN)).toEqual(noTotal('tq1other'))
      clock.now += QBIT_ACCOUNT_TOTAL_SETTLING_MS + 1_000
      totals.measured(client, 'tq1other', 2_000, totals.begin())
      expect(totals.peek(client, 'tq1other', CHAIN)).toEqual(noTotal('tq1other'))

      settled()
      expect(totals.peek(client, ADDRESS, CHAIN)).toMatchObject({
        totalBalance: 1_200,
        fresh: false,
      })
      const after = totals.read(client, ADDRESS, CHAIN)
      client.calls[1]!.answer(1_300)
      await expect(after).resolves.toMatchObject({ totalBalance: 1_300, fresh: true })
    })

    it('leaves a read begun during it and settled after it kept but not fresh', async () => {
      const { totals, client } = setup()
      const settled = totals.submission(client)
      const read = totals.read(client, ADDRESS, CHAIN)
      settled()
      client.calls[0]!.answer(1_000)
      await expect(read).resolves.toMatchObject({ totalBalance: 1_000, fresh: false })
    })

    it('counts the time the explorer may lag from when it ended', async () => {
      const { clock, totals, client } = setup()
      const settled = totals.submission(client)
      clock.now += 20_000
      settled()
      // 35 s after it began, 15 s after it ended.
      clock.now += 15_000
      const read = totals.read(client, ADDRESS, CHAIN)
      client.calls[0]!.answer(1_000)
      const { readAt } = await read
      clock.now = readAt! + QBIT_ACCOUNT_TOTAL_SETTLING_FRESH_MS
      expect(totals.peek(client, ADDRESS, CHAIN).fresh).toBe(false)
    })

    it('starts a read of its own for each call made during it, rather than wait on one begun during it', async () => {
      const { totals, client } = setup()
      const settled = totals.submission(client)
      const one = totals.read(client, ADDRESS, CHAIN)
      const two = totals.read(client, ADDRESS, CHAIN)
      await flush()
      expect(client.calls).toHaveLength(2)
      settled()
      // Begun before it ended: not shared after it either.
      const three = totals.read(client, ADDRESS, CHAIN)
      await flush()
      expect(client.calls).toHaveLength(3)
      client.calls[2]!.answer(1_200)
      await expect(three).resolves.toMatchObject({ totalBalance: 1_200, fresh: true })
      client.calls[0]!.answer(1_000)
      client.calls[1]!.answer(1_100)
      for (const answer of await Promise.all([one, two])) {
        expect(answer).toMatchObject({ totalBalance: 1_200 })
      }
    })

    it('counts each submission once, however often it is closed', async () => {
      const { totals, client } = setup()
      const first = totals.submission(client)
      first()
      first()
      const second = totals.submission(client)
      const read = totals.read(client, ADDRESS, CHAIN)
      client.calls[0]!.answer(1_000)
      await expect(read).resolves.toMatchObject({ fresh: false })
      second()
    })

    it('outlives a clear', async () => {
      const { totals, client } = setup()
      const settled = totals.submission(client)
      totals.clear()
      const read = totals.read(client, ADDRESS, CHAIN)
      client.calls[0]!.answer(1_000)
      await expect(read).resolves.toMatchObject({ totalBalance: 1_000, fresh: false })
      settled()
    })
  })

  describe('a total fed by a balance read', () => {
    it('counts as measured when that read began', () => {
      const { clock, totals, client } = setup()
      const balance = totals.begin()
      // Its statistics arrived, then its outputs took a while.
      clock.now += 15_000
      totals.measured(client, ADDRESS, 1_000, balance)
      expect(totals.peek(client, ADDRESS, CHAIN)).toMatchObject({
        readAt: balance.at,
        fresh: true,
      })
      clock.now = balance.at + QBIT_ACCOUNT_TOTAL_FRESH_MS - 1
      expect(totals.peek(client, ADDRESS, CHAIN).fresh).toBe(true)
      clock.now += 1
      expect(totals.peek(client, ADDRESS, CHAIN).fresh).toBe(false)
    })
  })

  describe('a clock that goes back', () => {
    it('makes no total fresh for longer', () => {
      const { clock, totals, client } = setup()
      totals.measured(client, ADDRESS, 1_000, totals.begin())
      expect(totals.peek(client, ADDRESS, CHAIN).fresh).toBe(true)
      clock.now -= 1_000
      expect(totals.peek(client, ADDRESS, CHAIN)).toMatchObject({
        totalBalance: 1_000,
        fresh: false,
      })
    })

    it('does not prolong the pause after a failure', async () => {
      const { clock, totals, client } = setup()
      const failing = totals.read(client, ADDRESS, CHAIN)
      client.calls[0]!.fail()
      await failing
      clock.now -= 1_000
      const again = totals.read(client, ADDRESS, CHAIN)
      await flush()
      expect(client.calls).toHaveLength(2)
      client.calls[1]!.answer(1)
      await again
    })
  })
})
