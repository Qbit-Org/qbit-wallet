import type { ChainType } from '@qbit/wallet-types'

import type { QbitBalanceSummary } from './common'

/**
 * The UI-port event a balance read (`getAddressBalanceV2`) reports its
 * progress with, sent only to the page whose call asked for it
 * (`QbitAddressBalanceOptions.progressId`), as signing progress is.
 */
export const QBIT_BALANCE_READ_PROGRESS = 'qbitBalanceReadProgress'

/** Options of `getAddressBalanceV2`, all optional: without them it reads as it always did. */
export interface QbitAddressBalanceOptions {
  /**
   * Chosen by the calling page to receive this read's progress
   * (`QbitBalanceReadProgress`), which carries it back. 1 to 64 letters,
   * digits, `_` or `-`; any other value gets no progress, and the read runs
   * as usual. The answer is the same either way.
   */
  progressId?: string
}

/**
 * How far one balance read has got, sent to the page that asked for it as
 * `QBIT_BALANCE_READ_PROGRESS`. Only while the wallet reads unlocked, the
 * address read is still the selected account's and the network is still the
 * one the read began on.
 *
 * - `total`: the address statistics answered, so the total is known before
 *   any output is read. It is the `totalBalance` the read's answer will
 *   carry; Available and Unavailable are not known yet. Sent once.
 * - `outputs`: how many of the outputs the explorer listed have been read
 *   (classified from a lookup, from facts kept from an earlier read, or from
 *   the listing alone for an output too deep to need a lookup), out of how
 *   many it listed. Sent a few times a second at most, and only when it
 *   changed.
 */
export type QbitBalanceReadProgress =
  | {
      progressId: string
      kind: 'total'
      address: string
      chainType: ChainType
      totalBalance: number
    }
  | {
      progressId: string
      kind: 'outputs'
      address: string
      chainType: ChainType
      read: number
      total: number
    }

/**
 * The last complete balance answer the background read for an address, kept
 * in memory only, for a newly opened page to show (dimmed, as possibly out of
 * date) while its own first read runs (`getKeptAddressBalance`).
 */
export interface QbitKeptAddressBalance {
  balance: QbitBalanceSummary
  /** When the read that answered it began, in ms since the epoch. */
  readAt: number
}

/**
 * Whether a balance answer is complete: its split is known, or it is past
 * the explorer's listing limit, a lasting cause the wallet states. An answer
 * that could not read every output (`utxoReadIncomplete`, `utxoReadFailed`),
 * or whose split is unknown because the send guard did not answer, is not:
 * its split is unknown for a passing reason. The one definition the
 * background (what it keeps) and the pages (what they show) share.
 */
export function isCompleteQbitBalance(balance: QbitBalanceSummary | undefined): boolean {
  if (balance === undefined || balance === null) return false
  if (balance.utxoReadIncomplete === true || balance.utxoReadFailed === true) return false
  return typeof balance.availableBalance === 'number' || balance.utxoLimitExceeded === true
}
