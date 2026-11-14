import { getEventListeners } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QbitApiError } from '@qbit-oss/api'
import {
  QBIT_BALANCE_READ_DEADLINE_MS,
  getQbitAddressUtxos,
  getQbitSpendableBalanceV2,
} from '../src/utils/qbit-api'
import { QbitFundingTxReads } from '../src/utils/qbit-funding-tx-reads'
import {
  ACCOUNT_ADDRESS,
  ACCOUNT_SCRIPT,
  FOREIGN_SCRIPT,
  testTxid,
} from './qbit-classify-reads-fake'

const address = ACCOUNT_ADDRESS
const listingUrl = `https://explorer.test/api/address/${address}/utxo`

/**
 * An explorer that answers each read after a delay, under the fake timers:
 * `txLatencyMs` for a transaction, `statsLatencyMs` for the statistics, a few
 * ms for anything else. A read whose signal aborts clears its timer and
 * rejects with the signal's reason, as the wallet's clients do.
 */
class TimedExplorer {
  txLatencyMs = 100
  statsLatencyMs = 5
  listingLatencyMs = 5
  /** Whether the statistics answer at `statsLatencyMs` even once their read is aborted. */
  statsIgnoreAbort = false
  readonly outputs: { txid: string; value: number; script: string; confirmed: boolean }[] = []
  readonly started: string[] = []
  readonly failures = new Map<string, unknown>()
  listingFailure: unknown
  statsFailure: unknown
  inFlight = 0
  peak = 0
  /** The height the listing reports every output confirmed at, under a tip of 2,000. */
  listedHeight = 100
  tipReads = 0

  constructor(count: number, { script = ACCOUNT_SCRIPT, salt = 0 } = {}) {
    this.add(count, { script, salt })
  }

  add(count: number, { script = ACCOUNT_SCRIPT, salt = 1, confirmed = true } = {}): void {
    for (let index = 0; index < count; index += 1) {
      this.outputs.push({ txid: testTxid(index, salt), value: 1_000 + index, script, confirmed })
    }
  }

  private status(output: { confirmed: boolean }) {
    return output.confirmed
      ? { confirmed: true, block_height: this.listedHeight }
      : { confirmed: false }
  }

  get total(): number {
    return this.outputs.reduce((sum, output) => sum + output.value, 0)
  }

  readonly client = {
    getAddressBalance: (_address: string, options?: { signal?: AbortSignal }) =>
      this.after(this.statsLatencyMs, this.statsIgnoreAbort ? undefined : options?.signal, () => {
        if (this.statsFailure !== undefined) throw this.statsFailure
        return { address, confirmedSats: this.total, mempoolSats: 0, totalSats: this.total }
      }),
    getAddressStats: (_address: string, options?: { signal?: AbortSignal }) =>
      this.after(this.statsLatencyMs, options?.signal, () => {
        throw new Error('no statistics read again on this path')
      }),
    getAddressUtxos: (_address: string, options?: { signal?: AbortSignal }) =>
      this.after(this.listingLatencyMs, options?.signal, () => {
        if (this.listingFailure !== undefined) throw this.listingFailure
        return this.outputs.map(output => ({
          txid: output.txid,
          vout: 0,
          value: output.value,
          status: this.status(output),
        }))
      }),
    getTipHeight: (options?: { signal?: AbortSignal }) => {
      this.tipReads += 1
      return this.after(5, options?.signal, () => 2_000)
    },
    getTx: (txid: string, options?: { signal?: AbortSignal }) => {
      this.started.push(txid)
      this.inFlight += 1
      this.peak = Math.max(this.peak, this.inFlight)
      const output = this.outputs.find(candidate => candidate.txid === txid)!
      return this.after(
        this.txLatencyMs,
        options?.signal,
        () => {
          if (this.failures.has(txid)) throw this.failures.get(txid)
          return {
            txid,
            vin: [{ is_coinbase: false, txid: testTxid(0, 99), vout: 0 }],
            vout: [{ scriptpubkey: output.script, value: output.value }],
            status: this.status(output),
          }
        },
        () => {
          this.inFlight -= 1
        }
      )
    },
  }

  private after<T>(
    ms: number,
    signal: AbortSignal | undefined,
    answer: () => T,
    settled: () => void = () => undefined
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer)
        settled()
        reject(signal!.reason)
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        settled()
        try {
          resolve(answer())
        } catch (error) {
          reject(error)
        }
      }, ms)
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

const incomplete = (total: number) => ({
  availableBalance: null,
  unavailableBalance: total,
  totalBalance: total,
  immatureBalance: null,
  pendingBalance: null,
  utxoReadIncomplete: true,
})

/** The incomplete answer of a read that stopped on a failure, not the deadline. */
const failedRead = (total: number) => ({ ...incomplete(total), utxoReadFailed: true })

const full = (available: number, total = available) => ({
  availableBalance: available,
  unavailableBalance: total - available,
  totalBalance: total,
  immatureBalance: 0,
  pendingBalance: 0,
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

describe('getQbitSpendableBalanceV2 with thousands of outputs (#169)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('has one 20 s deadline for the whole read', () => {
    expect(QBIT_BALANCE_READ_DEADLINE_MS).toBe(20_000)
  })

  it('reports the statistics total with the split unknown when one /tx read fails', async () => {
    const explorer = new TimedExplorer(50)
    const failure = new QbitApiError('http', 'HTTP 500 from /tx', {
      status: 500,
      url: `https://explorer.test/api/tx/${testTxid(10)}`,
    })
    explorer.failures.set(testTxid(10), failure)
    const readReserved = vi.fn(async () => new Set<string>())

    const read = getQbitSpendableBalanceV2(
      explorer.client as any,
      address,
      ACCOUNT_SCRIPT,
      readReserved
    )
    await vi.runAllTimersAsync()

    await expect(read).resolves.toEqual(failedRead(explorer.total))
    // Nothing to subtract reservations from.
    expect(readReserved).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives the same unknown split when the listing fails without a refusal', async () => {
    for (const listingFailure of [
      new QbitApiError('http', 'HTTP 503 from /utxo', { status: 503, url: listingUrl }),
      new QbitApiError('timeout', 'request timed out', { url: listingUrl }),
      new Error('invalid qbit UTXO response'),
    ]) {
      const explorer = new TimedExplorer(20)
      explorer.listingFailure = listingFailure
      const read = getQbitSpendableBalanceV2(explorer.client as any, address)
      await vi.runAllTimersAsync()
      await expect(read).resolves.toEqual(failedRead(explorer.total))
    }
  })

  it('marks a failure as failed though the statistics answer only near the deadline', async () => {
    const explorer = new TimedExplorer(20)
    explorer.statsLatencyMs = QBIT_BALANCE_READ_DEADLINE_MS - 1
    explorer.listingFailure = new QbitApiError('rate_limit', 'HTTP 429 from /utxo', {
      status: 429,
      url: listingUrl,
    })
    const read = track(getQbitSpendableBalanceV2(explorer.client as any, address))
    await vi.advanceTimersByTimeAsync(QBIT_BALANCE_READ_DEADLINE_MS - 1)
    expect(read).toMatchObject({ settled: true, value: failedRead(explorer.total) })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('marks a kept value the listing no longer agrees with as a failed read', async () => {
    const explorer = new TimedExplorer(10)
    const options = { fundingTxReads: new QbitFundingTxReads() }
    const first = getQbitSpendableBalanceV2(
      explorer.client as any,
      address,
      ACCOUNT_SCRIPT,
      undefined,
      undefined,
      options
    )
    await vi.runAllTimersAsync()
    await expect(first).resolves.toEqual(full(explorer.total))
    explorer.outputs[3]!.value += 1

    const second = getQbitSpendableBalanceV2(
      explorer.client as any,
      address,
      ACCOUNT_SCRIPT,
      undefined,
      undefined,
      options
    )
    await vi.runAllTimersAsync()
    await expect(second).resolves.toEqual(failedRead(explorer.total))
  })

  it('rejects when the statistics read fails, and reads no more of the outputs', async () => {
    const explorer = new TimedExplorer(1_000)
    explorer.statsLatencyMs = 250
    const failure = new QbitApiError('http', 'HTTP 502 from /address', { status: 502 })
    explorer.statsFailure = failure

    const read = track(getQbitSpendableBalanceV2(explorer.client as any, address))
    await vi.advanceTimersByTimeAsync(250)

    expect(read).toMatchObject({ settled: true, error: failure })
    const started = explorer.started.length
    expect(started).toBeLessThan(100)
    await vi.runAllTimersAsync()
    expect(explorer.started).toHaveLength(started)
    expect(explorer.inFlight).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports the split unknown at the deadline, and the next read takes up where it stopped', async () => {
    // 5,000 outputs at 100 ms a read, 16 at a time: 31 s of reads.
    const explorer = new TimedExplorer(5_000)
    const fundingTxReads = new QbitFundingTxReads()
    const options = { fundingTxReads }

    const first = track(
      getQbitSpendableBalanceV2(
        explorer.client as any,
        address,
        ACCOUNT_SCRIPT,
        undefined,
        undefined,
        options
      )
    )
    await vi.advanceTimersByTimeAsync(QBIT_BALANCE_READ_DEADLINE_MS - 1)
    expect(first.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(first).toMatchObject({ settled: true, value: incomplete(explorer.total) })
    // It ran out of time and is working through the outputs: not a failure.
    expect(first.value).not.toHaveProperty('utxoReadFailed')
    expect(vi.getTimerCount()).toBe(0)
    expect(explorer.inFlight).toBe(0)
    expect(explorer.peak).toBe(16)
    const kept = fundingTxReads.size
    expect(kept).toBeGreaterThan(2_500)
    expect(kept).toBeLessThan(5_000)

    // The next poll reads only what the first did not.
    explorer.started.length = 0
    const second = track(
      getQbitSpendableBalanceV2(
        explorer.client as any,
        address,
        ACCOUNT_SCRIPT,
        undefined,
        undefined,
        options
      )
    )
    await vi.advanceTimersByTimeAsync(QBIT_BALANCE_READ_DEADLINE_MS)
    expect(second).toMatchObject({ settled: true, value: full(explorer.total) })
    expect(explorer.started).toHaveLength(5_000 - kept)
    expect(vi.getTimerCount()).toBe(0)

    // And a steady poll of the unchanged outputs reads none.
    explorer.started.length = 0
    const third = track(
      getQbitSpendableBalanceV2(
        explorer.client as any,
        address,
        ACCOUNT_SCRIPT,
        undefined,
        undefined,
        options
      )
    )
    await vi.advanceTimersByTimeAsync(100)
    expect(third).toMatchObject({ settled: true, value: full(explorer.total) })
    expect(explorer.started).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  /** A balance read through `options`, under the fake timers, settled `ms` later. */
  async function balanceAfter(
    explorer: TimedExplorer,
    options: { fundingTxReads?: QbitFundingTxReads },
    ms = QBIT_BALANCE_READ_DEADLINE_MS
  ) {
    const read = track(
      getQbitSpendableBalanceV2(
        explorer.client as any,
        address,
        ACCOUNT_SCRIPT,
        undefined,
        undefined,
        options
      )
    )
    await vi.advanceTimersByTimeAsync(ms)
    expect(read.settled).toBe(true)
    return read.value
  }

  it('reports a failure as failed though the deadline passed before the answer could be made', async () => {
    // The statistics answer after the deadline, as from a read that does not
    // heed its signal. By then the outputs had stopped on a real failure,
    // after keeping some for the next read: that is still a failure.
    const explorer = new TimedExplorer(5_000)
    explorer.statsLatencyMs = QBIT_BALANCE_READ_DEADLINE_MS + 5_000
    explorer.statsIgnoreAbort = true
    explorer.failures.set(
      testTxid(1_500),
      new QbitApiError('http', 'HTTP 502 from /tx', { status: 502 })
    )
    const options = { fundingTxReads: new QbitFundingTxReads() }

    await expect(
      balanceAfter(explorer, options, QBIT_BALANCE_READ_DEADLINE_MS + 5_000)
    ).resolves.toEqual(failedRead(explorer.total))
    expect(options.fundingTxReads.size).toBeGreaterThan(1_000)
  })

  it('reads none of a listing longer than the shared reader keeps, and has the poll back off', async () => {
    const explorer = new TimedExplorer(101)
    const fundingTxReads = new QbitFundingTxReads({ maxOutpoints: 100 })

    // The statistics and the listing only, long before the deadline.
    await expect(balanceAfter(explorer, { fundingTxReads }, 50)).resolves.toEqual(
      failedRead(explorer.total)
    )
    expect(explorer.started).toEqual([])
    expect(explorer.tipReads).toBe(0)
    expect(fundingTxReads.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads a listing of exactly what the shared reader keeps over polls, then polls with no /tx read', async () => {
    // 5,000 outputs at 100 ms a read, 16 at a time: two polls.
    const explorer = new TimedExplorer(5_000)
    const fundingTxReads = new QbitFundingTxReads({ maxOutpoints: 5_000 })

    await expect(balanceAfter(explorer, { fundingTxReads })).resolves.toEqual(
      incomplete(explorer.total)
    )
    await expect(balanceAfter(explorer, { fundingTxReads })).resolves.toEqual(full(explorer.total))
    expect(fundingTxReads.size).toBe(5_000)
    explorer.started.length = 0
    await expect(balanceAfter(explorer, { fundingTxReads }, 100)).resolves.toEqual(
      full(explorer.total)
    )
    expect(explorer.started).toEqual([])
  })

  it('still reads every output of such a listing for a send', async () => {
    const explorer = new TimedExplorer(101)
    const fundingTxReads = new QbitFundingTxReads({ maxOutpoints: 100 })
    const read = track(getQbitAddressUtxos(explorer.client as any, address, { fundingTxReads }))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(read.settled).toBe(true)
    expect(read.value).toHaveLength(101)
    expect(new Set(explorer.started).size).toBe(101)
  })

  it('reports a read cut off while the listing still downloads as failed', async () => {
    const explorer = new TimedExplorer(10)
    explorer.listingLatencyMs = 60_000
    const options = { fundingTxReads: new QbitFundingTxReads() }

    await expect(balanceAfter(explorer, options)).resolves.toEqual(failedRead(explorer.total))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports a read cut off with nothing new kept for the next read as failed', async () => {
    const explorer = new TimedExplorer(5_000)
    const options = { fundingTxReads: new QbitFundingTxReads() }
    // The first read keeps what it read: it got somewhere.
    const first = await balanceAfter(explorer, options)
    expect(first).toEqual(incomplete(explorer.total))
    const kept = options.fundingTxReads.size
    // The rest hang: the second read keeps nothing new.
    explorer.txLatencyMs = 60_000

    await expect(balanceAfter(explorer, options)).resolves.toEqual(failedRead(explorer.total))
    expect(options.fundingTxReads.size).toBe(kept)
  })

  it('reports a warm account whose only unread outputs are unconfirmed as failed at the deadline', async () => {
    const explorer = new TimedExplorer(20)
    // Read afresh every time, so what they keep is nothing the next read is served.
    explorer.add(5_000, { salt: 4, confirmed: false })
    const options = { fundingTxReads: new QbitFundingTxReads() }
    await expect(balanceAfter(explorer, options)).resolves.toEqual(incomplete(explorer.total))

    await expect(balanceAfter(explorer, options)).resolves.toEqual(failedRead(explorer.total))
  })

  it('polls an unchanged address of payments younger than 1,000 blocks without a /tx or tip read', async () => {
    // Not coinbase outputs, and ten blocks deep: a read of outputs to spend
    // would read them again, but nothing is spent from the balance.
    const explorer = new TimedExplorer(30)
    explorer.listedHeight = 1_990
    const options = { fundingTxReads: new QbitFundingTxReads() }
    for (const reads of [30, 0, 0]) {
      explorer.started.length = 0
      explorer.tipReads = 0
      const poll = getQbitSpendableBalanceV2(
        explorer.client as any,
        address,
        ACCOUNT_SCRIPT,
        undefined,
        undefined,
        options
      )
      await vi.runAllTimersAsync()
      await expect(poll).resolves.toEqual(full(explorer.total))
      expect(explorer.started).toHaveLength(reads)
      expect(explorer.tipReads).toBe(0)
    }
  })

  for (const [age, height] of [
    ['old', 100],
    ['younger than 1,000 blocks', 1_990],
  ] as const) {
    it(`polls an unchanged 20,000-output address without one /tx read, its outputs ${age}`, async () => {
      const explorer = new TimedExplorer(20_000)
      explorer.txLatencyMs = 1
      explorer.listedHeight = height
      const options = { fundingTxReads: new QbitFundingTxReads() }
      const first = track(
        getQbitSpendableBalanceV2(
          explorer.client as any,
          address,
          ACCOUNT_SCRIPT,
          undefined,
          undefined,
          options
        )
      )
      await vi.advanceTimersByTimeAsync(QBIT_BALANCE_READ_DEADLINE_MS)
      expect(first).toMatchObject({ settled: true, value: full(explorer.total) })
      expect(explorer.started).toHaveLength(20_000)

      explorer.started.length = 0
      const poll = track(
        getQbitSpendableBalanceV2(
          explorer.client as any,
          address,
          ACCOUNT_SCRIPT,
          undefined,
          undefined,
          options
        )
      )
      await vi.advanceTimersByTimeAsync(50)
      expect(poll).toMatchObject({ settled: true, value: full(explorer.total) })
      expect(explorer.started).toEqual([])
    })
  }

  it('rejects with a timeout, not an abort, once the statistics outlast the deadline', async () => {
    const explorer = new TimedExplorer(10)
    explorer.statsLatencyMs = 60_000

    const read = track(getQbitSpendableBalanceV2(explorer.client as any, address))
    await vi.advanceTimersByTimeAsync(QBIT_BALANCE_READ_DEADLINE_MS)

    expect(read.settled).toBe(true)
    expect(read.error).toBeInstanceOf(QbitApiError)
    expect(read.error).toMatchObject({
      kind: 'timeout',
      message: expect.stringContaining('20000ms deadline'),
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it("rejects with the caller's reason once the caller gives up, and lets go of its signal", async () => {
    const explorer = new TimedExplorer(5_000)
    const controller = new AbortController()
    const reason = new Error('the popup closed')

    const read = track(
      getQbitSpendableBalanceV2(
        explorer.client as any,
        address,
        ACCOUNT_SCRIPT,
        undefined,
        undefined,
        {
          signal: controller.signal,
        }
      )
    )
    await vi.advanceTimersByTimeAsync(5_000)
    controller.abort(reason)
    await vi.advanceTimersByTimeAsync(0)

    expect(read).toMatchObject({ settled: true, error: reason })
    expect(explorer.inFlight).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)

    // A read that completes lets go of its signal too.
    const done = new AbortController()
    const small = new TimedExplorer(5)
    const complete = track(
      getQbitSpendableBalanceV2(
        small.client as any,
        address,
        ACCOUNT_SCRIPT,
        undefined,
        undefined,
        {
          signal: done.signal,
        }
      )
    )
    await vi.runAllTimersAsync()
    expect(complete).toMatchObject({ settled: true, value: full(small.total) })
    expect(getEventListeners(done.signal, 'abort')).toHaveLength(0)
  })

  it('stops waiting for the send guard at the deadline', async () => {
    const explorer = new TimedExplorer(10)
    const guard = new Promise<ReadonlySet<string>>(() => undefined)

    const read = track(
      getQbitSpendableBalanceV2(explorer.client as any, address, ACCOUNT_SCRIPT, () => guard)
    )
    await vi.advanceTimersByTimeAsync(QBIT_BALANCE_READ_DEADLINE_MS)

    // Without the reservations nothing counts as available, as when the
    // controller stops waiting for the guard; the outputs were read in full.
    expect(read).toMatchObject({
      settled: true,
      value: {
        availableBalance: null,
        unavailableBalance: explorer.total,
        totalBalance: explorer.total,
        immatureBalance: null,
        pendingBalance: null,
      },
    })
    expect(read.value).not.toHaveProperty('utxoReadIncomplete')
    expect(read.value).not.toHaveProperty('utxoReadFailed')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('takes its deadline from the options, and with nothing kept for the next read reports it failed', async () => {
    // No shared reader: nothing is kept, so the next read cannot build on it.
    const explorer = new TimedExplorer(1_000)
    const read = track(
      getQbitSpendableBalanceV2(
        explorer.client as any,
        address,
        ACCOUNT_SCRIPT,
        undefined,
        undefined,
        {
          deadlineMs: 1_000,
        }
      )
    )
    await vi.advanceTimersByTimeAsync(1_000)
    expect(read).toMatchObject({ settled: true, value: failedRead(explorer.total) })
    expect(vi.getTimerCount()).toBe(0)
  })

  it("counts only the account's own script, and keeps no other to serve", async () => {
    const explorer = new TimedExplorer(20)
    // Listed for the address, but answered with another script: never kept,
    // so read afresh on every poll, and never counted.
    explorer.add(5, { script: FOREIGN_SCRIPT, salt: 3 })
    const options = { fundingTxReads: new QbitFundingTxReads() }
    const own = explorer.outputs
      .filter(output => output.script === ACCOUNT_SCRIPT)
      .reduce((sum, output) => sum + output.value, 0)

    for (const reads of [25, 5, 5]) {
      explorer.started.length = 0
      const read = getQbitSpendableBalanceV2(
        explorer.client as any,
        address,
        ACCOUNT_SCRIPT,
        undefined,
        undefined,
        options
      )
      await vi.runAllTimersAsync()
      await expect(read).resolves.toEqual({ ...full(own, explorer.total), immatureBalance: 0 })
      expect(explorer.started).toHaveLength(reads)
    }
  })
})

describe('getQbitSpendableBalanceV2 past the listing limit, at the deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** An explorer that refuses the listing as `refusal` and reads the statistics again in `statsMs`. */
  function refusingClient(refusal: QbitApiError, statsMs: number) {
    const stats = {
      address,
      chain_stats: {
        funded_txo_count: 600,
        funded_txo_sum: 600_000,
        spent_txo_count: 0,
        spent_txo_sum: 0,
        tx_count: 600,
      },
      mempool_stats: {
        funded_txo_count: 0,
        funded_txo_sum: 0,
        spent_txo_count: 0,
        spent_txo_sum: 0,
        tx_count: 0,
      },
    }
    const after = <T>(ms: number, signal: AbortSignal | undefined, answer: () => T) =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => resolve(answer()), ms)
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(signal.reason)
          },
          { once: true }
        )
      })
    return {
      getAddressBalance: async () => ({
        address,
        confirmedSats: 600_000,
        mempoolSats: 0,
        totalSats: 600_000,
      }),
      getAddressUtxos: async () => {
        throw refusal
      },
      // Read again past the refusal, slowly.
      getAddressStats: (_address: string, options?: { signal?: AbortSignal }) =>
        after(statsMs, options?.signal, () => stats),
      getTipHeight: async () => 2_000,
      getTx: vi.fn(),
    }
  }

  it('rejects with the timeout when a refusal the explorer states cannot be checked in time', async () => {
    const refusal = new QbitApiError('payload_too_large', 'HTTP 413', {
      status: 413,
      url: listingUrl,
      responseBody:
        '{"error":"Too many unspent transaction outputs (>500). Contact support to raise limits."}',
    })
    const client = refusingClient(refusal, 60_000)
    const read = track(getQbitSpendableBalanceV2(client as any, address))
    await vi.advanceTimersByTimeAsync(QBIT_BALANCE_READ_DEADLINE_MS)
    expect(read.error).toMatchObject({ kind: 'timeout' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a bare 500 whose statistics cannot be read in time an ordinary failure', async () => {
    const refusal = new QbitApiError('http', 'HTTP 500 from /utxo', {
      status: 500,
      url: listingUrl,
      responseBody: '{"error":"Failed to get address"}',
    })
    const client = refusingClient(refusal, 60_000)
    const read = track(getQbitSpendableBalanceV2(client as any, address))
    await vi.advanceTimersByTimeAsync(QBIT_BALANCE_READ_DEADLINE_MS)
    expect(read).toMatchObject({ settled: true, value: failedRead(600_000) })
    expect(vi.getTimerCount()).toBe(0)
  })
})
