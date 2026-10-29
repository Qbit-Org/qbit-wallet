import {
  getQbitTxSpenders,
  normalizeQbitTxid,
  type QbitTxOutspendsClient,
  type QbitTxOutspendsOptions,
} from './qbit-api'
import { QbitExplorerOperation } from './qbit-explorer-fetch'

/**
 * The longest a broadcast waits for the explorer to say what spends a fee
 * bump's original, or a restored claim's inputs: both reads and the pause
 * between them. The check runs while the send guard holds its queue, so a
 * stalled explorer must not hold every other send flow for the client's
 * full retry budget. Its reads, `/tx/:txid/outspends`, are small replies,
 * which the explorer's reply budget expects within this too.
 */
export const QBIT_FEE_BUMP_RECHECK_WAIT_MS = 15_000

/**
 * The pause between the check's two reads, from the first one's answer.
 * One answer that nothing spends the original is not taken as the
 * explorer's word: its index can lag its node, and the replicas behind one
 * endpoint can disagree, so a payment made elsewhere moments ago may show
 * only on the next read. Both reads bypass the HTTP cache, so the second is
 * never the first one's reply again.
 */
export const QBIT_FEE_BUMP_RECHECK_INTERVAL_MS = 5_000

/**
 * The Speed up assessment's deadline, shared by every explorer read it
 * makes before the user signs: the original, its raw bytes and what spends
 * it. With 106 inputs the original is about 800 kB both as JSON and as hex,
 * about 1.6 MB together, which this fits at about 13 kB/s (about
 * 110 kbit/s), well below the 640 kbit/s under which the hex alone missed
 * the 10 s check that used to run at broadcast.
 */
export const QBIT_FEE_BUMP_ASSESSMENT_DEADLINE_MS = 120_000

/** What a broadcast checks on the explorer before it dispatches. */
export interface QbitExplorerSpendCheck {
  /**
   * A fee bump's original, and its output count from the assessment:
   * nothing may spend any of its outputs.
   */
  replaces?: { txid: string; outputCount: number | undefined }
  /**
   * A claim the send guard restored after a restart (see
   * `QbitSendGuardService.restoreBroadcastClaim`): its transaction and
   * inputs. The guard's records of what spends those inputs went with the
   * restart, so the explorer must show that nothing but that transaction,
   * or the original in `replaces`, spends them.
   */
  restored?: { txid: string; outpoints: readonly { txid: string; vout: number }[] }
}

/**
 * What a broadcast of `txid`, spending `outpoints`, checks on the explorer,
 * from what the send guard hands its callback (see
 * `QbitSendGuardService.broadcastIfAllowed`): the original a fee bump
 * `replaces`, and the inputs of a `restored` claim. Nothing, for a
 * broadcast that is neither.
 */
export function qbitExplorerSpendCheck(
  txid: string,
  outpoints: readonly { txid: string; vout: number }[],
  replaces?: string,
  replacedOutputCount?: number,
  restored = false
): QbitExplorerSpendCheck {
  return {
    ...(replaces ? { replaces: { txid: replaces, outputCount: replacedOutputCount } } : {}),
    ...(restored ? { restored: { txid, outpoints } } : {}),
  }
}

export interface QbitExplorerSpendCheckOptions {
  waitMs?: number
  intervalMs?: number
  operation?: QbitExplorerOperation
}

/**
 * Throw unless the explorer shows that a broadcast about to be dispatched
 * evicts nothing. qbit Core evicts every transaction spending an output of
 * the transaction a fee bump replaces once the replacement's fee covers
 * theirs, and a payment made after the bump was assessed (from another
 * wallet on the same seed, or a recipient spending their output) shows only
 * on the explorer: with `replaces`, what spends each output of the original
 * is read. A claim restored after a restart may replace a transaction the
 * guard no longer knows of, whatever the page says it replaces: with
 * `restored`, what spends each of its inputs is read as well, once per
 * transaction they are outputs of.
 *
 * The original's `outputCount` is the one counted from the raw bytes that
 * hash to its txid when the bump was assessed, before it was signed: the
 * original's bytes are never read again here, since on a slow link they can
 * take longer than the guard may be held, and their signature is spent by
 * now. Every read is fresh (`QbitTxOutspendsOptions.fresh`), and they all
 * run twice, `intervalMs` apart: the broadcast goes out only when both
 * rounds show nothing but the expected spenders. A spender on either
 * refuses it. So does an answer that is not well-formed (for the original,
 * one entry per output), or a check that has not settled within `waitMs`
 * (or before `operation`'s deadline): its reads are then aborted, and a
 * pause that would leave the second round no time gives up at once. The
 * broadcast goes out only on the explorer's explicit word.
 */
export async function assertNoExplorerSpendConflict(
  client: QbitTxOutspendsClient,
  spendCheck: QbitExplorerSpendCheck,
  options: QbitExplorerSpendCheckOptions = {}
): Promise<void> {
  const { replaces, restored } = spendCheck
  if (!replaces && !restored) return
  const {
    waitMs = QBIT_FEE_BUMP_RECHECK_WAIT_MS,
    intervalMs = QBIT_FEE_BUMP_RECHECK_INTERVAL_MS,
    operation,
  } = options
  const giveUp = new AbortController()
  const parent = operation?.signal
  const onParentAbort = (): void => giveUp.abort(parent?.reason)
  if (parent?.aborted) onParentAbort()
  else parent?.addEventListener('abort', onParentAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  let verdict: 'conflict' | 'dependent' | undefined
  try {
    const originalOutputCount = replaces?.outputCount
    if (replaces && originalOutputCount === undefined) {
      throw new Error('original output count unknown')
    }
    // One budget for the whole check, within the deadline of the broadcast
    // it is part of: each read gets what is left of it, never more.
    const budgetMs = Math.min(waitMs, operation?.remainingMs() ?? waitMs)
    const check = new QbitExplorerOperation(budgetMs, giveUp.signal)
    const read = (): QbitTxOutspendsOptions => ({ ...check.read(), fresh: true })
    const expected = new Set([restored?.txid, replaces?.txid])
    const round = async (): Promise<typeof verdict> => {
      const [originalSpenders, inputSpenders] = await Promise.all([
        replaces && originalOutputCount !== undefined
          ? getQbitTxSpenders(client, replaces.txid, originalOutputCount, read())
          : [],
        restored ? getQbitInputSpenders(client, restored.outpoints, read) : [],
      ])
      if (inputSpenders.some(spender => spender !== undefined && !expected.has(spender))) {
        return 'conflict'
      }
      return originalSpenders.some(spender => spender !== undefined) ? 'dependent' : undefined
    }
    const lookup = async (): Promise<typeof verdict> => {
      const first = await round()
      if (first) return first
      if (check.remainingMs() <= intervalMs) throw new Error('no time left for a second read')
      await pauseUnlessAborted(intervalMs, giveUp.signal)
      return round()
    }
    verdict = await Promise.race([
      lookup(),
      new Promise<never>((_, reject) => {
        const abandon = (): void => reject(giveUp.signal.reason)
        if (giveUp.signal.aborted) abandon()
        else giveUp.signal.addEventListener('abort', abandon, { once: true })
        timer = setTimeout(() => giveUp.abort(new Error('timed out')), budgetMs)
      }),
    ])
  } catch {
    throw new Error(
      'Could not check whether a later payment depends on the transaction this fee bump replaces'
    )
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', onParentAbort)
    // A read or pause still running is not waited for: it is aborted.
    if (!giveUp.signal.aborted) giveUp.abort(new Error('fee bump check settled'))
  }
  if (verdict === 'conflict') {
    throw new Error('Qbit transaction spends an input a recent broadcast already spent')
  }
  if (verdict === 'dependent') {
    throw new Error('A later payment depends on the transaction this fee bump replaces')
  }
}

/**
 * The txid spending each of `outpoints`, or undefined for one nothing
 * spends, from one `/tx/:txid/outspends` read per transaction they are
 * outputs of, all at once. That transaction's output count is not known
 * here, so an answer only has to hold a well-formed entry at the index of
 * each of `outpoints`; anything less throws, so a short or malformed answer
 * is never read as unspent.
 */
async function getQbitInputSpenders(
  client: QbitTxOutspendsClient,
  outpoints: readonly { txid: string; vout: number }[],
  read: () => QbitTxOutspendsOptions
): Promise<(string | undefined)[]> {
  const funding = [...new Set(outpoints.map(outpoint => normalizeQbitTxid(outpoint.txid)))]
  const answers = new Map(
    await Promise.all(
      funding.map(
        async txid => [txid, await client.getTxOutspends(txid, read())] as [string, unknown]
      )
    )
  )
  return outpoints.map(({ txid, vout }) => {
    const fundingTxid = normalizeQbitTxid(txid)
    const answer = answers.get(fundingTxid)
    const outspend: unknown = Array.isArray(answer) ? answer[vout] : undefined
    if (!outspend || typeof outspend !== 'object') {
      throw new Error(`invalid qbit outspends for ${fundingTxid}`)
    }
    const { spent, txid: spender } = outspend as { spent?: unknown; txid?: unknown }
    if (typeof spent !== 'boolean') throw new Error(`invalid qbit outspends for ${fundingTxid}`)
    if (!spent) return undefined
    const spenderTxid = normalizeQbitTxid(spender as string)
    if (spenderTxid === fundingTxid) throw new Error(`invalid qbit outspends for ${fundingTxid}`)
    return spenderTxid
  })
}

/** Wait `ms`, or reject as soon as `signal` aborts, leaving no timer behind. */
function pauseUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}
