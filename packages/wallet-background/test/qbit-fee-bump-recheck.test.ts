import { afterEach, describe, expect, it, vi } from 'vitest'

import { QbitApiError, type RequestOptions } from '@qbit-oss/api'
import { QbitExplorerOperation } from '../src/utils/qbit-explorer-fetch'
import {
  QBIT_FEE_BUMP_RECHECK_WAIT_MS,
  assertNoExplorerDependentSpend,
} from '../src/utils/qbit-fee-bump-recheck'

const ORIGINAL = 'aa'.repeat(32)
const LATER = 'bb'.repeat(32)
const DEPENDENT = 'A later payment depends on the transaction this fee bump replaces'
const UNCHECKED =
  'Could not check whether a later payment depends on the transaction this fee bump replaces'

/**
 * An explorer answering `outspends` for the original. It serves nothing
 * else: the check never reads the original's bytes, whose output count the
 * assessment counted before the bump was signed.
 */
function explorer(outspends: unknown) {
  return {
    getTxOutspends: vi.fn(async (_txid: string, _options?: RequestOptions) => outspends as any),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('assertNoExplorerDependentSpend', () => {
  it("passes only on the explorer's word that nothing spends any output of the original", async () => {
    const client = explorer([{ spent: false }, { spent: false }])
    await expect(assertNoExplorerDependentSpend(client, ORIGINAL, 2)).resolves.toBeUndefined()
    // One small read, under the check's own budget.
    expect(client.getTxOutspends).toHaveBeenCalledTimes(1)
    expect(client.getTxOutspends).toHaveBeenCalledWith(ORIGINAL, {
      deadlineMs: QBIT_FEE_BUMP_RECHECK_WAIT_MS,
      signal: expect.any(AbortSignal),
    })
  })

  it('refuses a fee bump whose original has a spent output, pending or confirmed', async () => {
    for (const status of [{ confirmed: false }, { confirmed: true }]) {
      const client = explorer([{ spent: false }, { spent: true, txid: LATER, vin: 0, status }])
      await expect(assertNoExplorerDependentSpend(client, ORIGINAL, 2)).rejects.toThrow(DEPENDENT)
    }
  })

  it('refuses when the explorer cannot say', async () => {
    // The original is gone: whatever replaced it may have later payments of its own.
    const gone = explorer([{ spent: false }])
    gone.getTxOutspends.mockRejectedValueOnce(new QbitApiError('not_found', 'HTTP 404'))
    const failing = explorer([{ spent: false }])
    failing.getTxOutspends.mockRejectedValueOnce(new QbitApiError('network', 'offline'))
    // One entry short: the missing output's spender would go unseen.
    const short = explorer([{ spent: false }])
    const malformed = explorer([{ spent: true }, { spent: false }])

    for (const client of [gone, failing, short, malformed]) {
      await expect(assertNoExplorerDependentSpend(client, ORIGINAL, 2)).rejects.toThrow(UNCHECKED)
    }
  })

  it('refuses, without asking, a fee bump whose original output count is unknown', async () => {
    const client = explorer([{ spent: false }])
    for (const count of [undefined, 0]) {
      await expect(assertNoExplorerDependentSpend(client, ORIGINAL, count)).rejects.toThrow(
        UNCHECKED
      )
    }
    expect(client.getTxOutspends).not.toHaveBeenCalled()
  })

  it('stops waiting for an explorer that does not answer, and aborts its read', async () => {
    vi.useFakeTimers()
    const stalled = explorer([{ spent: false }])
    let signal: AbortSignal | undefined
    stalled.getTxOutspends.mockImplementationOnce((_txid, options) => {
      signal = options?.signal
      return new Promise(() => undefined)
    })
    const check = assertNoExplorerDependentSpend(stalled, ORIGINAL, 1)
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
    const stalled = explorer([{ spent: false }])
    let options: RequestOptions | undefined
    stalled.getTxOutspends.mockImplementationOnce((_txid, given) => {
      options = given
      return new Promise(() => undefined)
    })
    const outcome = assertNoExplorerDependentSpend(stalled, ORIGINAL, 1, { operation }).catch(
      error => error
    )
    expect(options?.deadlineMs).toBe(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(((await outcome) as Error).message).toBe(UNCHECKED)
    expect(options?.signal?.aborted).toBe(true)

    await expect(
      assertNoExplorerDependentSpend(stalled, ORIGINAL, 1, { operation })
    ).rejects.toThrow(UNCHECKED)
    expect(stalled.getTxOutspends).toHaveBeenCalledTimes(1)
  })
})
