import { QbitApiError } from '@qbit-oss/api'

import {
  QBIT_OUTSPENDS_CONCURRENCY,
  findQbitOutpointSpenders,
  normalizeQbitTxid,
  qbitCancellableDelay,
  qbitOutspendsReadCount,
  type QbitTxOutspendsClient,
} from './qbit-api'
import { QBIT_BROADCAST_MIN_PASS_MS } from './qbit-broadcast'
import { QbitExplorerOperation } from './qbit-explorer-fetch'
import {
  qbitExplorerSpendCheckIsNeeded,
  type QbitExplorerSpendCheck,
} from './qbit-explorer-spend-check'

/**
 * The pause between the check's two rounds of reads, from the first one's
 * answers. One answer that nothing spends the original is not taken as the
 * explorer's word: its index can lag its node, and the replicas behind one
 * endpoint can disagree, so a payment made elsewhere moments ago may show
 * only on the next read. Every read is fresh, so the second is never the
 * first one's reply again.
 */
export const QBIT_FEE_BUMP_RECHECK_INTERVAL_MS = 5_000

/**
 * What each round of the check's budget gives each wave of reads
 * (`QBIT_OUTSPENDS_CONCURRENCY` in flight at once): a restored claim's
 * inputs can come from many transactions, each read once a round. Its
 * reads, `/tx/:txid/outspends`, are small replies, which the explorer's
 * reply budget expects within this too. With one wave and the default
 * pause, the check has 15 s: it runs while the send guard holds its queue,
 * so a stalled explorer must not hold every other send flow for the
 * client's full retry budget.
 */
export const QBIT_FEE_BUMP_RECHECK_WAVE_MS = 5_000

/**
 * The least each wave of reads in a round is given. The check starts only
 * with room for both rounds and the pause between them at this, and gives
 * up rather than pause when the first round leaves the second less.
 */
export const QBIT_FEE_BUMP_RECHECK_MIN_READ_MS = 2_000

/**
 * What the check leaves of a broadcast's deadline besides the submission's
 * reply budget (`QBIT_BROADCAST_MIN_PASS_MS`): a check that settles as its
 * budget ends hands back to the broadcast a moment later, which must still
 * find that budget left for the submission.
 */
export const QBIT_FEE_BUMP_RECHECK_SUBMISSION_MARGIN_MS = 250

/**
 * The longest the check may take, however many transactions it reads. The
 * largest standard wallet transaction has 106 single-key inputs (see
 * `QBIT_MAX_STANDARD_TX_WEIGHT`); from 106 transactions, and a fee bump's
 * original besides, that is 107 reads, 14 waves, which both rounds and the
 * pause fit at `QBIT_FEE_BUMP_RECHECK_MIN_READ_MS` a wave in 61 s. This
 * leaves those a few seconds more, and leaves a broadcast's 120 s deadline,
 * past the submission's 15 s, about 40 s for the lookups that follow a
 * refusal or a lost answer. The check holds the send guard's queue, and no
 * other send moves while it does: more than about a minute of that is
 * refused instead.
 */
export const QBIT_FEE_BUMP_RECHECK_MAX_WAIT_MS = 65_000

/**
 * The Speed up assessment's deadline, shared by every explorer read it
 * makes before the user signs: the original, its raw bytes and what spends
 * it. With 106 inputs the original is about 800 kB both as JSON and as hex,
 * about 1.6 MB together, which this fits at about 13 kB/s (about
 * 110 kbit/s), well below the 640 kbit/s under which the hex alone missed
 * the 10 s check that used to run at broadcast.
 */
export const QBIT_FEE_BUMP_ASSESSMENT_DEADLINE_MS = 120_000

export interface QbitExplorerSpendCheckOptions {
  /** The pause between the two rounds; the budget is sized with it. */
  intervalMs?: number
  /**
   * The broadcast the check is part of. The check leaves it
   * `QBIT_BROADCAST_MIN_PASS_MS` of its deadline and
   * `QBIT_FEE_BUMP_RECHECK_SUBMISSION_MARGIN_MS` more, so a check that
   * passes leaves the submission its whole reply budget.
   */
  operation?: QbitExplorerOperation
}

/**
 * The explorer check refused for lack of time: too little was left for both
 * rounds of reads or for the second one, or its reads timed out. A
 * broadcast reports it as a refusal for its deadline (`timeout`).
 */
export class QbitExplorerSpendCheckTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QbitExplorerSpendCheckTimeoutError'
  }
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
 * `restored`, what spends each of its inputs is read as well.
 *
 * The original's `outputCount` is the one counted from the raw bytes that
 * hash to its txid when the bump was assessed, before it was signed: the
 * original's bytes are never read again here, since on a slow link they can
 * take longer than the guard may be held, and their signature is spent by
 * now. All of it is read in one `findQbitOutpointSpenders` fan-out a round,
 * every read fresh (`QbitTxOutspendsOptions.fresh`), and the rounds run
 * twice, `intervalMs` apart: the broadcast goes out only when both rounds
 * show nothing but the expected spenders. A spender on either refuses it.
 * So does an answer that is not well-formed or a read that fails, at once,
 * or a check that has not settled within its budget; its reads still in
 * flight are then aborted.
 *
 * The budget is the pause, `intervalMs`, and `QBIT_FEE_BUMP_RECHECK_WAVE_MS`
 * a round for each wave, up to `QBIT_FEE_BUMP_RECHECK_MAX_WAIT_MS`, and no
 * more of `operation`'s deadline than leaves the submission its reply
 * budget. A budget without
 * `QBIT_FEE_BUMP_RECHECK_MIN_READ_MS` a wave for both rounds and the pause
 * refuses before any read, and a first round that leaves the second less
 * refuses without the pause; both throw `QbitExplorerSpendCheckTimeoutError`,
 * as does a check whose reads time out. The broadcast goes out only on the
 * explorer's explicit word.
 */
export async function assertNoExplorerSpendConflict(
  client: QbitTxOutspendsClient,
  spendCheck: QbitExplorerSpendCheck,
  options: QbitExplorerSpendCheckOptions = {}
): Promise<void> {
  if (!qbitExplorerSpendCheckIsNeeded(spendCheck)) return
  const { replaces, restored } = spendCheck
  const { intervalMs = QBIT_FEE_BUMP_RECHECK_INTERVAL_MS, operation } = options
  const giveUp = new AbortController()
  const parent = operation?.signal
  const onParentAbort = (): void => giveUp.abort(parent?.reason)
  if (parent?.aborted) onParentAbort()
  else parent?.addEventListener('abort', onParentAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  let outOfTime = false
  let verdict: 'conflict' | 'dependent' | undefined
  try {
    const outputCount = replaces?.outputCount ?? 0
    if (replaces && !(Number.isSafeInteger(outputCount) && outputCount >= 1)) {
      throw new Error('original output count unknown')
    }
    const original = replaces && normalizeQbitTxid(replaces.txid)
    const originalOutputs = original
      ? Array.from({ length: outputCount }, (_, vout) => ({ txid: original, vout, outputCount }))
      : []
    const inputs = (restored?.outpoints ?? []).map(({ txid, vout }) => ({
      txid: normalizeQbitTxid(txid),
      vout,
    }))
    const outputs = [...originalOutputs, ...inputs]
    // Nothing but the claim's own transaction, or the original it replaces,
    // may spend its inputs; spenders come back lowercase, so do these.
    const expected = new Set([restored && normalizeQbitTxid(restored.txid), original])

    // One budget for the whole check, sized for its reads, within the
    // deadline of the broadcast it is part of less what its submission
    // needs after it: each read gets what is left of it, never more.
    const waves = Math.ceil(qbitOutspendsReadCount(outputs) / QBIT_OUTSPENDS_CONCURRENCY)
    const budgetMs = Math.min(
      intervalMs + 2 * waves * QBIT_FEE_BUMP_RECHECK_WAVE_MS,
      QBIT_FEE_BUMP_RECHECK_MAX_WAIT_MS,
      operation
        ? operation.remainingMs() -
            QBIT_BROADCAST_MIN_PASS_MS -
            QBIT_FEE_BUMP_RECHECK_SUBMISSION_MARGIN_MS
        : Number.POSITIVE_INFINITY
    )
    if (!(budgetMs >= intervalMs + 2 * waves * QBIT_FEE_BUMP_RECHECK_MIN_READ_MS)) {
      outOfTime = true
      throw new Error('no time left for both rounds of reads')
    }
    const check = new QbitExplorerOperation(budgetMs, giveUp.signal)
    const round = async (): Promise<typeof verdict> => {
      const spenders = await findQbitOutpointSpenders(client, outputs, {
        operation: check,
        fresh: true,
        // One failed read or malformed answer decides the check: the reads
        // still in flight are aborted, and the refusal comes at once.
        onFailure: error => giveUp.abort(error),
      })
      const conflict = inputs.some(({ txid, vout }) => {
        const spender = spenders.get(`${txid}:${vout}`)
        return spender !== undefined && !expected.has(spender)
      })
      if (conflict) return 'conflict'
      return originalOutputs.some(({ txid, vout }) => spenders.has(`${txid}:${vout}`))
        ? 'dependent'
        : undefined
    }
    const lookup = async (): Promise<typeof verdict> => {
      const first = await round()
      if (first) return first
      if (check.remainingMs() < intervalMs + waves * QBIT_FEE_BUMP_RECHECK_MIN_READ_MS) {
        outOfTime = true
        throw new Error('no time left for a second read')
      }
      await qbitCancellableDelay(intervalMs, { signal: giveUp.signal })
      return round()
    }
    verdict = await Promise.race([
      lookup(),
      new Promise<never>((_, reject) => {
        const abandon = (): void => reject(giveUp.signal.reason)
        if (giveUp.signal.aborted) abandon()
        else giveUp.signal.addEventListener('abort', abandon, { once: true })
        timer = setTimeout(() => {
          outOfTime = true
          giveUp.abort(new Error('timed out'))
        }, budgetMs)
      }),
    ])
  } catch (error) {
    const message = replaces
      ? 'Could not check whether a later payment depends on the transaction this fee bump replaces'
      : 'Could not check that the inputs of this transaction are still unspent'
    // Either copy of the API client (CommonJS or ESM) may have thrown it.
    if (outOfTime || (QbitApiError.is(error) && error.kind === 'timeout')) {
      throw new QbitExplorerSpendCheckTimeoutError(message)
    }
    throw new Error(message)
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', onParentAbort)
    // A read or pause still running is not waited for: it is aborted.
    if (!giveUp.signal.aborted) giveUp.abort(new Error('fee bump check settled'))
  }
  // Spent by a transaction the explorer shows, not one this wallet sent.
  if (verdict === 'conflict') {
    throw new Error('Qbit transaction spends an input another transaction already spends')
  }
  if (verdict === 'dependent') {
    throw new Error('A later payment depends on the transaction this fee bump replaces')
  }
}
