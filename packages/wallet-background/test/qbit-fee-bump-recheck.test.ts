import { afterEach, describe, expect, it, vi } from 'vitest'

import { QbitApiError } from '@qbit-oss/api'
import {
  QBIT_OUTSPENDS_CONCURRENCY,
  QbitWalletEsploraClient,
  QbitWalletMempoolClient,
  type QbitTxOutspendsClient,
  type QbitTxOutspendsOptions,
} from '../src/utils/qbit-api'
import { QBIT_BROADCAST_MIN_PASS_MS } from '../src/utils/qbit-broadcast'
import {
  QBIT_EXPLORER_FRESH_READ_PARAM,
  QbitExplorerOperation,
} from '../src/utils/qbit-explorer-fetch'
import {
  QBIT_FEE_BUMP_RECHECK_INTERVAL_MS,
  QBIT_FEE_BUMP_RECHECK_MAX_WAIT_MS,
  QBIT_FEE_BUMP_RECHECK_MIN_READ_MS,
  QBIT_FEE_BUMP_RECHECK_WAIT_MS,
  QbitExplorerSpendCheckTimeoutError,
  QBIT_FEE_BUMP_RECHECK_WAVE_MS,
  assertNoExplorerSpendConflict,
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
const CONFLICT = 'Qbit transaction spends an input another transaction already spends'
const UNCHECKED =
  'Could not check whether a later payment depends on the transaction this fee bump replaces'
/** The refusal of a restored send that is not a fee bump, when its inputs cannot be checked. */
const UNCHECKED_RESTORED = 'Could not check that the inputs of this transaction are still unspent'

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
    { replaces: { txid, outputCount } },
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
    {
      ...(replaces ? { replaces: { txid: replaces, outputCount: 1 } } : {}),
      restored: { txid: BROADCAST, outpoints: INPUTS },
    },
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

/** The `n`th of a run of distinct txids. */
const txidOf = (n: number) => n.toString(16).padStart(64, '0')

/** An explorer answering every read with `answer`, `ms` after it was sent. */
function answeringAfter(ms: number, answer: unknown) {
  let inFlight = 0
  let mostInFlight = 0
  const client = {
    getTxOutspends: vi.fn(
      (_txid: string, _options?: QbitTxOutspendsOptions) =>
        new Promise<any>(resolve => {
          inFlight += 1
          mostInFlight = Math.max(mostInFlight, inFlight)
          setTimeout(() => {
            inFlight -= 1
            resolve(answer)
          }, ms)
        })
    ),
  }
  return { client, mostInFlight: () => mostInFlight }
}

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
      assertNoExplorerSpendConflict(client, {})
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
    // The check may spend 10 s of it: the rest is the submission's.
    const operation = new QbitExplorerOperation(QBIT_BROADCAST_MIN_PASS_MS + 10_000)
    const stalled = explorer([unspent])
    let options: QbitTxOutspendsOptions | undefined
    stalled.getTxOutspends.mockImplementationOnce((_txid, given) => {
      options = given
      return new Promise(() => undefined)
    })
    const outcome = checkBump(stalled, ORIGINAL, 1, { operation }).catch(error => error)
    expect(options?.deadlineMs).toBe(10_000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(((await outcome) as Error).message).toBe(UNCHECKED)
    expect(options?.signal?.aborted).toBe(true)

    await expect(checkBump(stalled, ORIGINAL, 1, { operation })).rejects.toThrow(UNCHECKED)
    expect(stalled.getTxOutspends).toHaveBeenCalledTimes(1)
  })

  it("leaves the broadcast's submission its reply budget, and refuses at once without room for both rounds", async () => {
    vi.useFakeTimers()
    const client = explorer([unspent])
    // 60 s left: the check's own budget caps it.
    await expect(
      settled(checkBump(client, ORIGINAL, 1, { operation: new QbitExplorerOperation(60_000) }))
    ).resolves.toBeUndefined()
    expect(client.getTxOutspends.mock.calls[0]![1]!.deadlineMs).toBe(QBIT_FEE_BUMP_RECHECK_WAIT_MS)
    // 29 s left: 14 s for the check, a second short of its own budget,
    // because the submission keeps 15 s.
    client.getTxOutspends.mockClear()
    await expect(
      settled(checkBump(client, ORIGINAL, 1, { operation: new QbitExplorerOperation(29_000) }))
    ).resolves.toBeUndefined()
    expect(client.getTxOutspends.mock.calls[0]![1]!.deadlineMs).toBe(14_000)
    // 25 s left: 10 s for the check, 15 s for the submission.
    client.getTxOutspends.mockClear()
    await expect(
      settled(checkBump(client, ORIGINAL, 1, { operation: new QbitExplorerOperation(25_000) }))
    ).resolves.toBeUndefined()
    expect(client.getTxOutspends.mock.calls.map(([, options]) => options!.deadlineMs)).toEqual([
      10_000,
      10_000 - QBIT_FEE_BUMP_RECHECK_INTERVAL_MS,
    ])

    // Too little left for two reads and the pause besides the submission's
    // budget: refused before any read, rather than holding the queue for a
    // check that could only end in a refusal for lack of time.
    client.getTxOutspends.mockClear()
    const tight =
      QBIT_BROADCAST_MIN_PASS_MS +
      2 * QBIT_FEE_BUMP_RECHECK_MIN_READ_MS +
      QBIT_FEE_BUMP_RECHECK_INTERVAL_MS -
      1
    await expect(
      checkBump(client, ORIGINAL, 1, { operation: new QbitExplorerOperation(tight) })
    ).rejects.toThrow(UNCHECKED)
    expect(client.getTxOutspends).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sizes its budget with the pause it is given', async () => {
    vi.useFakeTimers()
    // Each read takes 4 s. With a 10 s pause the budget is 20 s: 5 s for
    // each round, and the pause; the second round still starts with 6 s.
    const slow = answeringAfter(4_000, [unspent])
    const outcome = checkBump(slow.client, ORIGINAL, 1, { intervalMs: 10_000 }).then(
      () => undefined,
      error => error
    )
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await outcome).toBeUndefined()
    expect(slow.client.getTxOutspends.mock.calls.map(([, options]) => options!.deadlineMs)).toEqual(
      [10_000 + 2 * QBIT_FEE_BUMP_RECHECK_WAVE_MS, 2 * QBIT_FEE_BUMP_RECHECK_WAVE_MS - 4_000]
    )
    // Without a pause, it is the two rounds' alone.
    const quick = explorer([unspent])
    await expect(settled(checkBump(quick, ORIGINAL, 1, { intervalMs: 0 }))).resolves.toBe(
      undefined
    )
    expect(quick.getTxOutspends.mock.calls[0]![1]!.deadlineMs).toBe(
      2 * QBIT_FEE_BUMP_RECHECK_WAVE_MS
    )
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

  it('refuses without pausing when the first read leaves the second less than its minimum budget', async () => {
    vi.useFakeTimers()
    const slow = explorer([unspent])
    // 6.999 s are left: enough for the pause, not for the pause and a read.
    const firstReadMs =
      QBIT_FEE_BUMP_RECHECK_WAIT_MS -
      QBIT_FEE_BUMP_RECHECK_INTERVAL_MS -
      QBIT_FEE_BUMP_RECHECK_MIN_READ_MS +
      1
    slow.getTxOutspends.mockImplementationOnce(
      () => new Promise(resolve => setTimeout(() => resolve([unspent]), firstReadMs))
    )
    const outcome = checkBump(slow, ORIGINAL, 1).catch(error => error)
    await vi.advanceTimersByTimeAsync(firstReadMs)
    expect(((await outcome) as Error).message).toBe(UNCHECKED)
    expect(slow.getTxOutspends).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refuses a fee bump when the first read shows a payment, whatever the second would say', async () => {
    vi.useFakeTimers()
    // A payment that the explorer shows and then loses (a replica behind,
    // or a reorganized mempool) is still a payment the bump would evict.
    const client = explorer([unspent])
    client.getTxOutspends.mockResolvedValueOnce([spentBy(LATER)])
    expect(((await settled(checkBump(client, ORIGINAL, 1))) as Error).message).toBe(DEPENDENT)
    expect(client.getTxOutspends).toHaveBeenCalledTimes(1)
  })

  it('stops its pause at once when the broadcast it is part of is cancelled between rounds', async () => {
    vi.useFakeTimers()
    const cancel = new AbortController()
    const client = explorer([unspent])
    const outcome = checkBump(client, ORIGINAL, 1, {
      operation: new QbitExplorerOperation(60_000, cancel.signal),
    }).catch(error => error)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(client.getTxOutspends).toHaveBeenCalledTimes(1)
    cancel.abort(new Error('cancelled'))
    expect(((await outcome) as Error).message).toBe(UNCHECKED)
    // No pause is left running, and no second read follows.
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(QBIT_FEE_BUMP_RECHECK_INTERVAL_MS)
    expect(client.getTxOutspends).toHaveBeenCalledTimes(1)
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
  it('reports a refusal for lack of time as such, and no other', async () => {
    vi.useFakeTimers()
    const outOfTime = async (check: Promise<void>): Promise<boolean> => {
      const outcome = (await settled(check)) as Error
      expect(outcome.message).toBe(UNCHECKED)
      return outcome instanceof QbitExplorerSpendCheckTimeoutError
    }
    const stalled = explorer([unspent])
    stalled.getTxOutspends.mockImplementation(() => new Promise(() => undefined))
    const slowFirst = explorer([unspent])
    slowFirst.getTxOutspends.mockImplementationOnce(
      () => new Promise(resolve => setTimeout(() => resolve([unspent]), 9_000))
    )
    const timedOut = explorer([unspent])
    timedOut.getTxOutspends.mockRejectedValueOnce(new QbitApiError('timeout', 'deadline'))
    // No room for both rounds, none for the second, reads that never answer
    // or that time out: all for lack of time.
    expect(
      await outOfTime(
        checkBump(explorer([unspent]), ORIGINAL, 1, {
          operation: new QbitExplorerOperation(QBIT_BROADCAST_MIN_PASS_MS + 1_000),
        })
      )
    ).toBe(true)
    expect(await outOfTime(checkBump(slowFirst, ORIGINAL, 1))).toBe(true)
    expect(await outOfTime(checkBump(stalled, ORIGINAL, 1))).toBe(true)
    expect(await outOfTime(checkBump(timedOut, ORIGINAL, 1))).toBe(true)

    // A failed or malformed answer, or a cancelled broadcast, is not.
    const failing = explorer([unspent])
    failing.getTxOutspends.mockRejectedValueOnce(new QbitApiError('network', 'offline'))
    const cancelled = new AbortController()
    cancelled.abort(new Error('cancelled'))
    expect(await outOfTime(checkBump(failing, ORIGINAL, 1))).toBe(false)
    expect(await outOfTime(checkBump(explorer([{ spent: 'no' }]), ORIGINAL, 1))).toBe(false)
    expect(
      await outOfTime(
        checkBump(explorer([unspent]), ORIGINAL, 1, {
          operation: new QbitExplorerOperation(60_000, cancelled.signal),
        })
      )
    ).toBe(false)
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
      expect(((await settled(checkRestored(client))) as Error).message).toBe(UNCHECKED_RESTORED)
    }
    const failing = explorerOf({})
    expect(((await settled(checkRestored(failing))) as Error).message).toBe(UNCHECKED_RESTORED)
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

  it('refuses a restored send when one funding read fails, times out or stalls on its own', async () => {
    vi.useFakeTimers()
    for (const [failure, timedOut] of [
      [new QbitApiError('timeout', 'operation exceeded its deadline'), true],
      [new QbitApiError('aborted', 'request aborted'), false],
      [new QbitApiError('network', 'offline'), false],
    ] as const) {
      const client = explorerOf({ [FUNDING]: [unspent, unspent] })
      client.getTxOutspends.mockRejectedValueOnce(failure)
      const outcome = (await settled(checkRestored(client))) as Error
      expect(outcome.message).toBe(UNCHECKED_RESTORED)
      // Only a read that ran out of time makes the refusal one for time.
      expect(outcome instanceof QbitExplorerSpendCheckTimeoutError).toBe(timedOut)
      expect(client.getTxOutspends).toHaveBeenCalledTimes(1)
    }
    // Only the funding read stalls; the original's answers at once.
    const stalled = explorerOf({ [FUNDING]: [unspent, unspent], [ORIGINAL]: [unspent] })
    let fundingSignal: AbortSignal | undefined
    stalled.getTxOutspends.mockImplementation(async (txid, options) => {
      if (txid !== FUNDING) return [unspent]
      fundingSignal = options?.signal
      return new Promise(() => undefined)
    })
    const outcome = checkRestored(stalled, ORIGINAL).catch(error => error)
    await vi.advanceTimersByTimeAsync(QBIT_FEE_BUMP_RECHECK_WAIT_MS - 1)
    expect(fundingSignal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(((await outcome) as Error).message).toBe(UNCHECKED)
    expect(fundingSignal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refuses a restored send when the first read of its inputs shows another spender and the second does not', async () => {
    vi.useFakeTimers()
    const client = explorerOf({ [FUNDING]: [unspent, unspent] })
    client.getTxOutspends.mockResolvedValueOnce([unspent, spentBy(LATER)])
    expect(((await settled(checkRestored(client))) as Error).message).toBe(CONFLICT)
    expect(client.getTxOutspends).toHaveBeenCalledTimes(1)
  })

  it('reads each funding transaction once a round, eight at a time, and refuses what cannot finish in time', async () => {
    vi.useFakeTimers()
    // Twelve inputs from ten transactions, two of them twice.
    const funding = Array.from({ length: 10 }, (_, index) => txidOf(index + 1))
    const outpoints = [
      ...funding.map(txid => ({ txid, vout: 0 })),
      { txid: funding[0]!, vout: 1 },
      { txid: funding[1]!, vout: 1 },
    ]
    const pending: (() => void)[] = []
    let inFlight = 0
    let mostInFlight = 0
    const client = explorer([unspent, unspent])
    client.getTxOutspends.mockImplementation(
      () =>
        new Promise(resolve => {
          inFlight += 1
          mostInFlight = Math.max(mostInFlight, inFlight)
          pending.push(() => {
            inFlight -= 1
            resolve([unspent, unspent])
          })
        })
    )
    const check = (): Promise<void> =>
      assertNoExplorerSpendConflict(client, { restored: { txid: BROADCAST, outpoints } })

    // Answered as they come, both rounds pass, and never more than eight
    // reads are in flight.
    const passing = check().then(
      () => undefined,
      error => error
    )
    for (let round = 0; round < 2; round += 1) {
      for (let answered = 0; answered < funding.length; answered += 1) {
        await vi.advanceTimersByTimeAsync(0)
        expect(inFlight).toBeLessThanOrEqual(QBIT_OUTSPENDS_CONCURRENCY)
        pending.shift()!()
      }
      await vi.advanceTimersByTimeAsync(QBIT_FEE_BUMP_RECHECK_INTERVAL_MS)
    }
    await expect(passing).resolves.toBeUndefined()
    expect(mostInFlight).toBe(QBIT_OUTSPENDS_CONCURRENCY)
    expect(client.getTxOutspends).toHaveBeenCalledTimes(2 * funding.length)
    expect(new Set(client.getTxOutspends.mock.calls.map(([txid]) => txid))).toEqual(
      new Set(funding)
    )

    // Answered too slowly, they do not all finish within the budget, which
    // two waves of reads make 25 s: the check refuses for lack of time,
    // aborts the reads in flight and starts no more.
    client.getTxOutspends.mockClear()
    pending.length = 0
    inFlight = 0
    const slow = check().catch(error => error)
    await vi.advanceTimersByTimeAsync(25_000 - 1)
    expect(client.getTxOutspends.mock.calls.some(([, options]) => options?.signal?.aborted)).toBe(
      false
    )
    await vi.advanceTimersByTimeAsync(1)
    expect(((await slow) as Error).message).toBe(UNCHECKED_RESTORED)
    expect((await slow) instanceof QbitExplorerSpendCheckTimeoutError).toBe(true)
    expect(client.getTxOutspends).toHaveBeenCalledTimes(QBIT_OUTSPENDS_CONCURRENCY)
    expect(
      client.getTxOutspends.mock.calls.every(([, options]) => options?.signal?.aborted)
    ).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('passes a restored consolidation of 80 inputs from 80 transactions, with replies of realistic speed', async () => {
    vi.useFakeTimers()
    // Each reply takes 400 ms. Ten waves of eight take 4 s a round, which
    // the 15 s budget of one wave could never hold for both rounds.
    const { client, mostInFlight } = answeringAfter(400, [unspent])
    const outpoints = Array.from({ length: 80 }, (_, index) => ({ txid: txidOf(index + 1), vout: 0 }))
    const operation = new QbitExplorerOperation(120_000)
    const startedAt = Date.now()
    let settledAt: number | undefined
    const outcome = assertNoExplorerSpendConflict(
      client,
      { restored: { txid: BROADCAST, outpoints } },
      { operation }
    ).then(
      () => {
        settledAt = Date.now()
      },
      error => error
    )
    await vi.advanceTimersByTimeAsync(QBIT_FEE_BUMP_RECHECK_MAX_WAIT_MS)
    expect(await outcome).toBeUndefined()
    expect(client.getTxOutspends).toHaveBeenCalledTimes(160)
    expect(mostInFlight()).toBe(QBIT_OUTSPENDS_CONCURRENCY)
    expect(client.getTxOutspends.mock.calls.every(([, options]) => options?.fresh)).toBe(true)
    // Done in about 13 s: both rounds of ten waves and the pause.
    expect(settledAt! - startedAt).toBe(2 * 10 * 400 + QBIT_FEE_BUMP_RECHECK_INTERVAL_MS)

    // So does the largest standard transaction: 106 inputs from 106
    // transactions, as a fee bump whose original is read besides.
    const largest = answeringAfter(400, [unspent])
    const bump = assertNoExplorerSpendConflict(largest.client, {
      replaces: { txid: ORIGINAL, outputCount: 1 },
      restored: {
        txid: BROADCAST,
        outpoints: Array.from({ length: 106 }, (_, index) => ({ txid: txidOf(index + 1), vout: 0 })),
      },
    }).then(
      () => undefined,
      error => error
    )
    await vi.advanceTimersByTimeAsync(QBIT_FEE_BUMP_RECHECK_MAX_WAIT_MS)
    expect(await bump).toBeUndefined()
    expect(largest.client.getTxOutspends).toHaveBeenCalledTimes(2 * 107)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refuses at once, before any read, a restored send whose reads cannot fit in time', async () => {
    vi.useFakeTimers()
    const { client } = answeringAfter(400, [unspent])
    const restoredFrom = (count: number) => ({
      restored: {
        txid: BROADCAST,
        outpoints: Array.from({ length: count }, (_, index) => ({ txid: txidOf(index + 1), vout: 0 })),
      },
    })
    // Seventeen waves need 73 s at the least, past the cap.
    const tooMany = assertNoExplorerSpendConflict(client, restoredFrom(130)).catch(error => error)
    // Eighty transactions need 45 s at the least; the broadcast has 50 s
    // left, 35 s of it past the submission's reply budget.
    const tooLate = assertNoExplorerSpendConflict(client, restoredFrom(80), {
      operation: new QbitExplorerOperation(50_000),
    }).catch(error => error)
    for (const outcome of [await tooMany, await tooLate]) {
      expect((outcome as Error).message).toBe(UNCHECKED_RESTORED)
      expect(outcome instanceof QbitExplorerSpendCheckTimeoutError).toBe(true)
    }
    expect(client.getTxOutspends).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('compares spenders with the claim it restored in one case, whatever case the txid was given in', async () => {
    vi.useFakeTimers()
    // The explorer shows the restored transaction itself spending the input.
    const client = explorerOf({ [FUNDING]: [unspent, spentBy(BROADCAST)] })
    await expect(
      settled(
        assertNoExplorerSpendConflict(client, {
          restored: { txid: BROADCAST.toUpperCase(), outpoints: INPUTS },
        })
      )
    ).resolves.toBeUndefined()
  })
  it('refuses at once on the first malformed answer, aborting the reads still in flight', async () => {
    vi.useFakeTimers()
    const STALLED = txidOf(1)
    let stalledSignal: AbortSignal | undefined
    const client = explorer([unspent])
    client.getTxOutspends.mockImplementation(async (txid, options) => {
      if (txid === FUNDING) return 'not a list'
      stalledSignal = options?.signal
      return new Promise(() => undefined)
    })
    let settledAt: number | undefined
    const startedAt = Date.now()
    const outcome = assertNoExplorerSpendConflict(client, {
      restored: { txid: BROADCAST, outpoints: [{ txid: STALLED, vout: 0 }, ...INPUTS] },
    }).catch(error => {
      settledAt = Date.now()
      return error
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settledAt).toBe(startedAt)
    const error = (await outcome) as Error
    expect(error.message).toBe(UNCHECKED_RESTORED)
    // A malformed answer is no lack of time.
    expect(error instanceof QbitExplorerSpendCheckTimeoutError).toBe(false)
    expect(stalledSignal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("the wallet's explorer clients", () => {
  const BASE = 'https://explorer.invalid/api'
  const ROUTE = `${BASE}/tx/${ORIGINAL}/outspends`
  const reply = () =>
    new Response(JSON.stringify([unspent]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

  it("send the recheck's reads under URLs of their own, past every cache, and no other read", async () => {
    vi.useFakeTimers()
    for (const Client of [QbitWalletEsploraClient, QbitWalletMempoolClient]) {
      const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => reply())
      const client = new Client({ baseUrl: BASE, fetchFn })
      await expect(settled(checkBump(client, ORIGINAL, 1))).resolves.toBeUndefined()
      await expect(client.getTxOutspends(ORIGINAL)).resolves.toEqual([unspent])

      expect(fetchFn).toHaveBeenCalledTimes(3)
      const [first, second, plain] = fetchFn.mock.calls.map(([input, init]) => ({
        url: new URL(String(input)),
        cache: init?.cache,
      }))
      // A nonce no other request carries: no cache in front of the
      // explorer can answer either read with the other's reply.
      for (const read of [first!, second!]) {
        expect(`${read.url.origin}${read.url.pathname}`).toBe(ROUTE)
        expect(read.url.searchParams.get(QBIT_EXPLORER_FRESH_READ_PARAM)).toMatch(/^[0-9a-f]{24}$/)
        expect(read.cache).toBe('no-store')
      }
      expect(first!.url.href).not.toBe(second!.url.href)
      expect(plain).toEqual({ url: new URL(ROUTE), cache: undefined })
    }
  })

  it('never join a fresh read to an ordinary read of the same route in flight, or the other way round', async () => {
    const answers: ((response: Response) => void)[] = []
    const fetchFn = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>(resolve => answers.push(resolve))
    )
    const client = new QbitWalletEsploraClient({ baseUrl: BASE, fetchFn })
    const plain = client.getTxOutspends(ORIGINAL)
    const fresh = client.getTxOutspends(ORIGINAL, { fresh: true })
    const plainAgain = client.getTxOutspends(ORIGINAL)
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2))
    const [plainCall, freshCall] = fetchFn.mock.calls
    expect([String(plainCall![0]), plainCall![1]?.cache]).toEqual([ROUTE, undefined])
    expect(String(freshCall![0])).toContain(`${ROUTE}?${QBIT_EXPLORER_FRESH_READ_PARAM}=`)
    expect(freshCall![1]?.cache).toBe('no-store')
    for (const answer of answers) answer(reply())
    await expect(Promise.all([plain, fresh, plainAgain])).resolves.toEqual([
      [unspent],
      [unspent],
      [unspent],
    ])
    // Ordinary reads still share one request.
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})
