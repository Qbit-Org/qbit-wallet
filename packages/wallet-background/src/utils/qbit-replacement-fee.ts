import { qbitMaximumTotalFee } from '@qbit/wallet-shared'

/** What a transaction pays in fees, and its exact size: qbit counts witness bytes in full. */
export interface QbitReplacementFeeTerms {
  fee: number
  vsize: number
}

/**
 * Whether a transaction paying `replacement.fee` for `replacement.vsize`
 * bytes may replace one paying `original.fee` for `original.vsize`, by the
 * rule the wallet's fee bump applies: a fee that is a safe integer within
 * the wallet's maximum total fee for the replacement's size, higher than the
 * original's, at a higher rate, and higher by at least one bit per byte of
 * the replacement. qbit Core asks a replacement for a higher rate and for
 * added fee of 0.25 bits per vbyte of its own size
 * (DEFAULT_INCREMENTAL_RELAY_FEE{250} sat/kvB); the wallet deliberately asks
 * four times that, so a replacement is valid also at a node that raises its
 * incremental relay fee to 1 bit/vB.
 */
export function qbitReplacementFeeAllowed(
  original: QbitReplacementFeeTerms,
  replacement: QbitReplacementFeeTerms
): boolean {
  const { fee, vsize } = replacement
  return (
    Number.isSafeInteger(fee) &&
    fee <= qbitMaximumTotalFee(vsize) &&
    fee - original.fee >= vsize &&
    fee > original.fee &&
    fee / vsize > original.fee / original.vsize
  )
}
