import { describe, expect, it, vi } from 'vitest'

import { QbitApiError } from '@qbit-oss/api'
import { transactionCore } from '@qbit/wallet-core'
import { assertNoExplorerDependentSpend } from '../src/utils/qbit-fee-bump-recheck'

const LATER = 'bb'.repeat(32)
const DEPENDENT = 'A later payment depends on the transaction this fee bump replaces'
const UNCHECKED =
  'Could not check whether a later payment depends on the transaction this fee bump replaces'

/** Raw bytes of an original with `outputs` P2MR outputs, and their txid. */
function rawOriginal(outputs: number) {
  const transaction = new transactionCore.Transaction()
  transaction.addInput(Buffer.alloc(32, 1), 0)
  for (let index = 0; index < outputs; index += 1) {
    transaction.addOutput(Buffer.from(`5220${'22'.repeat(32)}`, 'hex'), 1_000 + index)
  }
  return { hex: transaction.toHex(), txid: transaction.getId() }
}

/** An explorer serving the original with `outputs` outputs and `outspends` for them. */
function explorer(outputs: number, outspends: unknown) {
  const original = rawOriginal(outputs)
  return {
    txid: original.txid,
    getTxHex: vi.fn(async () => original.hex),
    getTxOutspends: vi.fn(async () => outspends as any),
  }
}

describe('assertNoExplorerDependentSpend', () => {
  it("passes only on the explorer's word that nothing spends any output of the original", async () => {
    const client = explorer(2, [{ spent: false }, { spent: false }])
    await expect(assertNoExplorerDependentSpend(client, client.txid)).resolves.toBeUndefined()
    expect(client.getTxHex).toHaveBeenCalledWith(client.txid)
    expect(client.getTxOutspends).toHaveBeenCalledWith(client.txid)
  })

  it('refuses a fee bump whose original has a spent output, pending or confirmed', async () => {
    for (const status of [{ confirmed: false }, { confirmed: true }]) {
      const client = explorer(2, [{ spent: false }, { spent: true, txid: LATER, vin: 0, status }])
      await expect(assertNoExplorerDependentSpend(client, client.txid)).rejects.toThrow(DEPENDENT)
    }
  })

  it('refuses when the explorer cannot say', async () => {
    const failing = explorer(1, [{ spent: false }])
    failing.getTxHex.mockRejectedValueOnce(new QbitApiError('network', 'offline'))
    // The original is gone: whatever replaced it may have later payments of its own.
    const gone = explorer(1, [{ spent: false }])
    gone.getTxOutspends.mockRejectedValueOnce(new QbitApiError('http', 'HTTP 500'))
    // Bytes of another transaction, which say nothing about this one's outputs.
    const otherBytes = explorer(1, [{ spent: false }])
    otherBytes.getTxHex.mockResolvedValueOnce(rawOriginal(2).hex)
    // One entry short: the missing output's spender would go unseen.
    const short = explorer(2, [{ spent: false }])
    const malformed = explorer(1, [{ spent: true }])

    for (const client of [failing, gone, otherBytes, short, malformed]) {
      await expect(assertNoExplorerDependentSpend(client, client.txid)).rejects.toThrow(UNCHECKED)
    }
  })

  it('stops waiting for an explorer that does not answer', async () => {
    const stalled = explorer(1, [{ spent: false }])
    stalled.getTxHex.mockReturnValueOnce(new Promise(() => undefined))
    await expect(assertNoExplorerDependentSpend(stalled, stalled.txid, 5)).rejects.toThrow(
      UNCHECKED
    )
  })
})
