import { afterEach, describe, expect, it, vi } from 'vitest'

import { QbitApiError } from '@qbit-oss/api'
import {
  QbitWalletEsploraClient,
  QbitWalletMempoolClient,
  type QbitTxOutspendsClient,
  type QbitTxOutspendsOptions,
} from '../src/utils/qbit-api'
import { QbitExplorerOperation } from '../src/utils/qbit-explorer-fetch'
import {
  QBIT_FEE_BUMP_RECHECK_INTERVAL_MS,
  QBIT_FEE_BUMP_RECHECK_WAIT_MS,
  assertNoExplorerSpendConflict,
  qbitExplorerSpendCheck,
  type QbitExplorerSpendCheckOptions,
} from '../src/utils/qbit-fee-bump-recheck'

const ORIGINAL = 'aa'.repeat(32)
const LATER = 'bb'.repeat(32)
/** A fee bump of `ORIGINAL`, or a send restored after a restart. */
const BROADCAST = 'cc'.repeat(32)
/** The transaction whose output the original spent, and the bump spends again. */
const FUNDING = 'dd'.repeat(32)
const INPUTS = [{ txid: FUNDING, vout: 1 }]
const DEPENDENT = 'A later payment depends on the transaction this fee bump replaces'
const CONFLICT = 'Qbit transaction spends an input a recent broadcast already spent'
const UNCHECKED =
  'Could not check whether a later payment depends on the transaction this fee bump replaces'

/**
 * An explorer answering `outspends` for the original. It serves nothing
 * else: the check never reads the original's bytes, whose output count the
 * assessment counted before the bump was signed.
 */
function explorer(outspends: unknown) {
  return {
    getTxOutspends: vi.fn(
      async (_txid: string, _options?: QbitTxOutspendsOptions) => outspends as any
    ),
  }
}

/** An explorer answering `outspends` for each transaction in `answers`. */
function explorerOf(answers: Record<string, unknown>) {
  return {
    getTxOutspends: vi.fn(async (txid: string, _options?: QbitTxOutspendsOptions) => {
      if (!(txid in answers)) throw new QbitApiError('not_found', 'HTTP 404')
      return answers[txid] as any
    }),
  }
}

/** The check a fee bump of `txid`, with `outputCount` outputs, gets at broadcast. */
function checkBump(
  client: QbitTxOutspendsClient,
  txid: string,
  outputCount: number | undefined,
  options?: QbitExplorerSpendCheckOptions
): Promise<void> {
  return assertNoExplorerSpendConflict(
    client,
    qbitExplorerSpendCheck(BROADCAST, INPUTS, txid, outputCount),
    options
  )
}

/** The check a claim restored after a restart gets at broadcast. */
function checkRestored(
  client: QbitTxOutspendsClient,
  replaces?: string,
  options?: QbitExplorerSpendCheckOptions
): Promise<void> {
  return assertNoExplorerSpendConflict(
    client,
    qbitExplorerSpendCheck(BROADCAST, INPUTS, replaces, replaces ? 1 : undefined, true),
    options
  )
}

/** Run a check to its end, its pause between reads included. */
async function settled(check: Promise<void>): Promise<unknown> {
  const outcome = check.then(
    () => undefined,
    error => error
  )
  await vi.advanceTimersByTimeAsync(QBIT_FEE_BUMP_RECHECK_WAIT_MS)
  return outcome
}

const unspent = { spent: false }
const spentBy = (txid: string) => ({ spent: true, txid, vin: 0, status: { confirmed: false } })

afterEach(() => {
  vi.useRealTimers()
})

describe('assertNoExplorerSpendConflict for a fee bump', () => {
  it("passes only on the explorer's word, twice, that nothing spends any output of the original", async () => {
    vi.useFakeTimers()
    const client = explorer([unspent, unspent])
    await expect(settled(checkBump(client, ORIGINAL, 2))).resolves.toBeUndefined()
    // Two small, fresh reads a pause apart, both under the check's one budget.
    expect(client.getTxOutspends).toHaveBeenCalledTimes(2)
    const [first, second] = client.getTxOutspends.mock.calls.map(([txid, options]) => {
      expect(txid).toBe(ORIGINAL)
      return options
    })
    expect(first).toEqual({
      deadlineMs: QBIT_FEE_BUMP_RECHECK_WAIT_MS,
      signal: expect.any(AbortSignal),
      fresh: true,
    })
    expect(second).toEqual({
      deadlineMs: QBIT_FEE_BUMP_RECHECK_WAIT_MS - QBIT_FEE_BUMP_RECHECK_INTERVAL_MS,
      signal: expect.any(AbortSignal),
      fresh: true,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refuses a fee bump when a payment spending its original shows only on the second read', async () => {
    vi.useFakeTimers()
    // The explorer had not yet seen a payment made elsewhere moments ago.
    const client = explorer([unspent, spentBy(LATER)])
    client.getTxOutspends.mockResolvedValueOnce([unspent, unspent])
    const outcome = await settled(checkBump(client, ORIGINAL, 2))
    expect((outcome as Error).message).toBe(DEPENDENT)
    expect(client.getTxOutspends).toHaveBeenCalledTimes(2)
  })

  it('refuses a fee bump unless the second read answers as well', async () => {
    vi.useFakeTimers()
    const unanswered = explorer([unspent])
    unanswered.getTxOutspends
      .mockResolvedValueOnce([unspent])
      .mockRejectedValueOnce(new QbitApiError('network', 'offline'))
    const short = explorer([])
    short.getTxOutspends.mockResolvedValueOnce([unspent])
    for (const client of [unanswered, short]) {
      const outcome = await settled(checkBump(client, ORIGINAL, 1))
      expect((outcome as Error).message).toBe(UNCHECKED)
      expect(client.getTxOutspends).toHaveBeenCalledTimes(2)
    }
  })

  it('refuses a fee bump whose original has a spent output, pending or confirmed', async () => {
    for (const status of [{ confirmed: false }, { confirmed: true }]) {
      const client = explorer([unspent, { spent: true, txid: LATER, vin: 0, status }])
      await expect(checkBump(client, ORIGINAL, 2)).rejects.toThrow(DEPENDENT)
    }
  })

  it('refuses when the explorer cannot say', async () => {
    // The original is gone: whatever replaced it may have later payments of its own.
    const gone = explorer([unspent])
    gone.getTxOutspends.mockRejectedValueOnce(new QbitApiError('not_found', 'HTTP 404'))
    const failing = explorer([unspent])
    failing.getTxOutspends.mockRejectedValueOnce(new QbitApiError('network', 'offline'))
    // One entry short: the missing output's spender would go unseen.
    const short = explorer([unspent])
    const malformed = explorer([{ spent: true }, unspent])

    for (const client of [gone, failing, short, malformed]) {
      await expect(checkBump(client, ORIGINAL, 2)).rejects.toThrow(UNCHECKED)
    }
  })

  it('refuses, without asking, a fee bump whose original output count is unknown', async () => {
    const client = explorer([unspent])
    for (const count of [undefined, 0]) {
      await expect(checkBump(client, ORIGINAL, count)).rejects.toThrow(UNCHECKED)
    }
    expect(client.getTxOutspends).not.toHaveBeenCalled()
  })

  it('checks nothing for a broadcast that is neither a fee bump nor restored', async () => {
    const client = explorer([unspent])
    await expect(
      assertNoExplorerSpendConflict(client, qbitExplorerSpendCheck(BROADCAST, INPUTS))
    ).resolves.toBeUndefined()
    expect(client.getTxOutspends).not.toHaveBeenCalled()
  })

  it('stops waiting for an explorer that does not answer, and aborts its read', async () => {
    vi.useFakeTimers()
    const stalled = explorer([unspent])
    let signal: AbortSignal | undefined
    stalled.getTxOutspends.mockImplementationOnce((_txid, options) => {
      signal = options?.signal
      return new Promise(() => undefined)
    })
    const check = checkBump(stalled, ORIGINAL, 1)
    const outcome = check.catch(error => error)
    await vi.advanceTimersByTimeAsync(QBIT_FEE_BUMP_RECHECK_WAIT_MS - 1)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(((await outcome) as Error).message).toBe(UNCHECKED)
    // The read is not left downloading once the check has given up.
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives up by the deadline of the broadcast it is part of, and reads nothing once that passed', async () => {
    vi.useFakeTimers()
    const operation = new QbitExplorerOperation(5_000)
    const stalled = explorer([unspent])
    let options: QbitTxOutspendsOptions | undefined
    stalled.getTxOutspends.mockImplementationOnce((_txid, given) => {
      options = given
      return new Promise(() => undefined)
    })
    const outcome = checkBump(stalled, ORIGINAL, 1, { operation }).catch(error => error)
    expect(options?.deadlineMs).toBe(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(((await outcome) as Error).message).toBe(UNCHECKED)
    expect(options?.signal?.aborted).toBe(true)

    await expect(checkBump(stalled, ORIGINAL, 1, { operation })).rejects.toThrow(UNCHECKED)
    expect(stalled.getTxOutspends).toHaveBeenCalledTimes(1)
  })

  it('aborts its second read when the check runs out of time, and never lets a read outlive it', async () => {
    vi.useFakeTimers()
    const stalled = explorer([unspent])
    const reads: QbitTxOutspendsOptions[] = []
    stalled.getTxOutspends
      .mockImplementationOnce(async (_txid, options) => {
        reads.push(options!)
        return [unspent]
      })
      .mockImplementationOnce((_txid, options) => {
        reads.push(options!)
        return new Promise(() => undefined)
      })
    const outcome = checkBump(stalled, ORIGINAL, 1).catch(error => error)
    await vi.advanceTimersByTimeAsync(QBIT_FEE_BUMP_RECHECK_INTERVAL_MS)
    expect(reads).toHaveLength(2)
    // The second read is given only what is left of the check's budget.
    expect(reads[1]!.deadlineMs).toBe(
      QBIT_FEE_BUMP_RECHECK_WAIT_MS - QBIT_FEE_BUMP_RECHECK_INTERVAL_MS
    )
    await vi.advanceTimersByTimeAsync(
      QBIT_FEE_BUMP_RECHECK_WAIT_MS - QBIT_FEE_BUMP_RECHECK_INTERVAL_MS - 1
    )
    expect(reads[1]!.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(((await outcome) as Error).message).toBe(UNCHECKED)
    expect(reads.map(read => read.signal?.aborted)).toEqual([true, true])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives up at once, reading nothing more, when a slow first read leaves no time for the second', async () => {
    vi.useFakeTimers()
    const slow = explorer([unspent])
    slow.getTxOutspends.mockImplementationOnce(
      () => new Promise(resolve => setTimeout(() => resolve([unspent]), 10_001))
    )
    const outcome = checkBump(slow, ORIGINAL, 1).catch(error => error)
    await vi.advanceTimersByTimeAsync(10_001)
    // 4.999 s are left, less than the pause: the bump is refused now.
    expect(((await outcome) as Error).message).toBe(UNCHECKED)
    expect(slow.getTxOutspends).toHaveBeenCalledTimes(1)
    expect(slow.getTxOutspends.mock.calls[0]![1]!.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts its reads when the broadcast it is part of is cancelled', async () => {
    vi.useFakeTimers()
    const cancel = new AbortController()
    const operation = new QbitExplorerOperation(60_000, cancel.signal)
    const stalled = explorer([unspent])
    let signal: AbortSignal | undefined
    stalled.getTxOutspends.mockImplementationOnce((_txid, options) => {
      signal = options?.signal
      return new Promise(() => undefined)
    })
    const outcome = checkBump(stalled, ORIGINAL, 1, { operation }).catch(error => error)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(signal?.aborted).toBe(false)
    cancel.abort(new Error('cancelled'))
    expect(((await outcome) as Error).message).toBe(UNCHECKED)
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)

    // Cancelled before it starts, it reads nothing.
    await expect(checkBump(stalled, ORIGINAL, 1, { operation })).rejects.toThrow(UNCHECKED)
    expect(stalled.getTxOutspends).toHaveBeenCalledTimes(1)
  })
})

describe('assertNoExplorerSpendConflict for a claim restored after a restart', () => {
  it('passes a restored send whose inputs nothing else spends, on two fresh reads of each funding transaction', async () => {
    vi.useFakeTimers()
    // Its own transaction may have reached the node meanwhile.
    for (const spender of [unspent, spentBy(BROADCAST)]) {
      const client = explorerOf({ [FUNDING]: [spentBy(LATER), spender] })
      await expect(settled(checkRestored(client))).resolves.toBeUndefined()
      expect(client.getTxOutspends.mock.calls).toEqual([
        [FUNDING, expect.objectContaining({ fresh: true, signal: expect.any(AbortSignal) })],
        [FUNDING, expect.objectContaining({ fresh: true, signal: expect.any(AbortSignal) })],
      ])
    }
    // Two inputs from one transaction: one read of it a round.
    const client = explorerOf({ [FUNDING]: [unspent, unspent] })
    await expect(
      settled(
        assertNoExplorerSpendConflict(client, {
          restored: { txid: BROADCAST, outpoints: [...INPUTS, { txid: FUNDING, vout: 0 }] },
        })
      )
    ).resolves.toBeUndefined()
    expect(client.getTxOutspends).toHaveBeenCalledTimes(2)
  })

  it('refuses a restored send, whatever it says it replaces, whose input another transaction spends', async () => {
    vi.useFakeTimers()
    // A page naming nothing for what is a fee bump of ORIGINAL, or naming
    // the wrong original: either would evict ORIGINAL and what spends it.
    for (const replaces of [undefined, LATER]) {
      const client = explorerOf({ [FUNDING]: [unspent, spentBy(ORIGINAL)], [LATER]: [unspent] })
      const outcome = await settled(checkRestored(client, replaces))
      expect((outcome as Error).message).toBe(CONFLICT)
    }
    // Naming the right one, it is checked as a fee bump of it.
    const named = explorerOf({ [FUNDING]: [unspent, spentBy(ORIGINAL)], [ORIGINAL]: [unspent] })
    await expect(settled(checkRestored(named, ORIGINAL))).resolves.toBeUndefined()
    expect(named.getTxOutspends.mock.calls.map(([txid]) => txid).sort()).toEqual(
      [FUNDING, FUNDING, ORIGINAL, ORIGINAL].sort()
    )
    const dependent = explorerOf({
      [FUNDING]: [unspent, spentBy(ORIGINAL)],
      [ORIGINAL]: [spentBy(LATER)],
    })
    expect(((await settled(checkRestored(dependent, ORIGINAL))) as Error).message).toBe(DEPENDENT)
  })

  it('refuses a restored send when the second read of its inputs disagrees with the first', async () => {
    vi.useFakeTimers()
    const client = explorerOf({ [FUNDING]: [unspent, spentBy(ORIGINAL)] })
    client.getTxOutspends.mockResolvedValueOnce([unspent, unspent])
    const outcome = await settled(checkRestored(client))
    expect((outcome as Error).message).toBe(CONFLICT)
    expect(client.getTxOutspends).toHaveBeenCalledTimes(2)
  })

  it('refuses a restored send unless every input has a well-formed answer', async () => {
    vi.useFakeTimers()
    for (const answer of [
      // Too short to hold the input's entry.
      [unspent],
      // Spent, by nothing it names.
      [unspent, { spent: true }],
      // Spent by the transaction it is an output of.
      [unspent, spentBy(FUNDING)],
      'not a list',
    ]) {
      const client = explorerOf({ [FUNDING]: answer })
      expect(((await settled(checkRestored(client))) as Error).message).toBe(UNCHECKED)
    }
    const failing = explorerOf({})
    expect(((await settled(checkRestored(failing))) as Error).message).toBe(UNCHECKED)
  })

  it('aborts every read of a restored send when the check runs out of time', async () => {
    vi.useFakeTimers()
    const stalled = explorer([unspent])
    const signals: AbortSignal[] = []
    stalled.getTxOutspends.mockImplementation((_txid, options) => {
      signals.push(options!.signal!)
      return new Promise(() => undefined)
    })
    const outcome = checkRestored(stalled, ORIGINAL).catch(error => error)
    await vi.advanceTimersByTimeAsync(QBIT_FEE_BUMP_RECHECK_WAIT_MS)
    expect(((await outcome) as Error).message).toBe(UNCHECKED)
    // The original's read and its input's, both aborted.
    expect(signals).toHaveLength(2)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("the wallet's explorer clients", () => {
  const BASE = 'https://explorer.invalid/api'

  it("send the recheck's reads past the HTTP cache, and no other read", async () => {
    vi.useFakeTimers()
    for (const Client of [QbitWalletEsploraClient, QbitWalletMempoolClient]) {
      const fetchFn = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify([unspent]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      )
      const client = new Client({ baseUrl: BASE, fetchFn })
      await expect(settled(checkBump(client, ORIGINAL, 1))).resolves.toBeUndefined()
      await expect(client.getTxOutspends(ORIGINAL)).resolves.toEqual([unspent])

      expect(fetchFn).toHaveBeenCalledTimes(3)
      expect(fetchFn.mock.calls.map(([input]) => String(input))).toEqual(
        Array(3).fill(`${BASE}/tx/${ORIGINAL}/outspends`)
      )
      expect(fetchFn.mock.calls.map(([, init]) => init?.cache)).toEqual([
        'no-store',
        'no-store',
        undefined,
      ])
    }
  })
})
