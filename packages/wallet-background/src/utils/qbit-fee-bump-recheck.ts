import { getQbitTxSpenders, type QbitTxOutspendsClient } from './qbit-api'

/**
 * The longest a fee bump's broadcast waits for the explorer to say what
 * spends its original. The check runs while the send guard holds its queue,
 * so a stalled explorer must not hold every other send flow for the
 * client's full retry budget. Its one read, `/tx/:txid/outspends`, is a
 * small reply, which the explorer's reply budget expects within this too.
 */
export const QBIT_FEE_BUMP_RECHECK_WAIT_MS = 15_000

/**
 * Throw unless the explorer reports that nothing spends an output of
 * `txid`, the transaction a fee bump is about to replace. qbit Core evicts
 * every transaction spending an output of the transaction it replaces once
 * the replacement's fee covers theirs, and a payment made after the bump
 * was assessed (from another wallet on the same seed, or a recipient
 * spending their output) shows only on the explorer.
 *
 * `outputCount` is the original's, counted from the raw bytes that hash to
 * `txid` when the bump was assessed, before it was signed: the original's
 * bytes are never read again here, since on a slow link they can take
 * longer than the guard may be held, and their signature is spent by now.
 * Only `/tx/:txid/outspends` is read. An answer that is not one
 * well-formed entry per output, or none within `waitMs`, throws as well,
 * and the read is aborted: the bump goes out only on the explorer's
 * explicit word.
 */
export async function assertNoExplorerDependentSpend(
  client: QbitTxOutspendsClient,
  txid: string,
  outputCount: number | undefined,
  waitMs = QBIT_FEE_BUMP_RECHECK_WAIT_MS
): Promise<void> {
  const giveUp = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let dependent: boolean
  try {
    if (outputCount === undefined) throw new Error('original output count unknown')
    const read = { deadlineMs: waitMs, signal: giveUp.signal }
    const lookup = async (): Promise<boolean> => {
      const spenders = await getQbitTxSpenders(client, txid, outputCount, read)
      return spenders.some(spender => spender !== undefined)
    }
    dependent = await Promise.race([
      lookup(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), waitMs)
      }),
    ])
  } catch {
    throw new Error(
      'Could not check whether a later payment depends on the transaction this fee bump replaces'
    )
  } finally {
    clearTimeout(timer)
    // A read still running is not waited for: it is aborted.
    giveUp.abort(new Error('fee bump check settled'))
  }
  if (dependent) {
    throw new Error('A later payment depends on the transaction this fee bump replaces')
  }
}
