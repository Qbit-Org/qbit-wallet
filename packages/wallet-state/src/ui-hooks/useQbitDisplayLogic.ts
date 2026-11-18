import { numUtils } from '@qbit/base-utils'
import { BigNumber } from 'bignumber.js'

/** A balance as a screen shows it; see `numUtils.formatBalance`. */
export type FormattedBalance = NonNullable<ReturnType<typeof numUtils.formatBalance>>

/**
 * A balance as `satoshisToAmount` writes it ("118591.83137906"), as a screen
 * shows it: see `numUtils.formatBalance`. Null for the unknown placeholder
 * `--` and for anything else that is not a string of an amount of coins (no
 * leading zeros, at most eight decimals), which is never formatted as if it
 * were a number.
 */
export function formatBalanceAmount(amount: string): FormattedBalance | null {
  if (typeof amount !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,8})?$/.test(amount)) return null
  // In satoshis, as the digits of a whole number: the amount has at most eight decimals.
  return numUtils.formatBalance(new BigNumber(amount).shiftedBy(8).toFixed(0))
}

/**
 * The parts of a balance as the home card sets them: the whole coins with
 * the point, larger, then the five decimals, and the exact amount for the
 * hover text and a screen reader. An unknown balance is `--` in the
 * decimals' place, with no exact amount.
 */
export function useQbitDisplayLogic(balance: string) {
  const formatted = formatBalanceAmount(balance)
  if (!formatted) {
    return { totalAmountMainPart: '', totalAmountSubPart: '--', exactAmount: undefined }
  }
  return {
    totalAmountMainPart: `${formatted.whole}.`,
    totalAmountSubPart: formatted.decimals,
    exactAmount: formatted.exact,
  }
}
