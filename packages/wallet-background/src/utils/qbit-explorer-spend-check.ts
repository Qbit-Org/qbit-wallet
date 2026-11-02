// The explorer check's description, apart from the check itself
// (`assertNoExplorerSpendConflict`): the send guard builds it without
// loading the explorer client.

/**
 * What a broadcast checks on the explorer before it dispatches, as the send
 * guard hands it over (see `QbitSendGuardService.broadcastIfAllowed`):
 * nothing for a broadcast that is neither a fee bump nor restored.
 */
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
 * The explorer check for a broadcast of `txid`, spending `outpoints`, as
 * the send guard hands it over: the transaction the claim it runs under
 * `replaces`, with that transaction's output count, and the inputs of a
 * claim `restoredFromPage`. `{}`, nothing to check, for any other broadcast.
 */
export function qbitExplorerSpendCheckFor(broadcast: {
  txid: string
  outpoints: readonly { txid: string; vout: number }[]
  replaces?: string | undefined
  replacedOutputCount?: number | undefined
  restoredFromPage?: boolean
}): QbitExplorerSpendCheck {
  const { txid, outpoints, replaces, replacedOutputCount, restoredFromPage = false } = broadcast
  return {
    ...(replaces ? { replaces: { txid: replaces, outputCount: replacedOutputCount } } : {}),
    ...(restoredFromPage ? { restored: { txid, outpoints } } : {}),
  }
}

/**
 * Throw unless `spendCheck` is a check the send guard handed over, `{}`
 * included. A broadcast handed none is refused rather than taken as having
 * nothing to check: a fee bump or a restored claim whose check went missing
 * on the way must not go out unchecked.
 */
export function assertQbitExplorerSpendCheck(
  spendCheck: unknown
): asserts spendCheck is QbitExplorerSpendCheck {
  if (typeof spendCheck !== 'object' || spendCheck === null || Array.isArray(spendCheck)) {
    throw new Error('Qbit broadcast was handed no explorer check')
  }
}

/** Whether `spendCheck` has anything for the explorer to check. */
export function qbitExplorerSpendCheckIsNeeded(spendCheck: QbitExplorerSpendCheck): boolean {
  return spendCheck.replaces !== undefined || spendCheck.restored !== undefined
}
