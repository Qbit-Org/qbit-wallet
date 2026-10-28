import {
  getQbitRawTransaction,
  getQbitTxSpenders,
  type QbitEsploraClient,
  type QbitTxOutspendsClient,
} from './qbit-api'

/**
 * The longest a fee bump's broadcast waits for the explorer to say what
 * spends its original. The check runs while the send guard holds its queue,
 * so a stalled explorer must not hold every other send flow for the
 * client's full retry budget.
 */
export const QBIT_FEE_BUMP_RECHECK_WAIT_MS = 10_000

/**
 * Throw unless the explorer reports that nothing spends an output of
 * `txid`, the transaction a fee bump is about to replace. qbit Core evicts
 * every transaction spending an output of the transaction it replaces once
 * the replacement's fee covers theirs, and a payment made after the bump
 * was assessed (from another wallet on the same seed, or a recipient
 * spending their output) shows only on the explorer. The outputs are
 * counted from raw bytes that hash to `txid`, as the assessment counts
 * them, and an answer that is not one well-formed entry per output, or
 * none within `waitMs`, throws as well: the bump goes out only on the
 * explorer's explicit word.
 */
export async function assertNoExplorerDependentSpend(
  client: Pick<QbitEsploraClient, 'getTxHex'> & QbitTxOutspendsClient,
  txid: string,
  waitMs = QBIT_FEE_BUMP_RECHECK_WAIT_MS
): Promise<void> {
  const lookup = async (): Promise<boolean> => {
    const { transaction } = await getQbitRawTransaction(client, txid)
    const spenders = await getQbitTxSpenders(client, txid, transaction.outs.length)
    return spenders.some(spender => spender !== undefined)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let dependent: boolean
  try {
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
  }
  if (dependent) {
    throw new Error('A later payment depends on the transaction this fee bump replaces')
  }
}
