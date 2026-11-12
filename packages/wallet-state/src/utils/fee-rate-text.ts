/**
 * From this rate up a double is coarser than a hundredth of a bit/vB, so no
 * hundredth can be picked out; no transaction pays anywhere near it (the
 * whole supply over the smallest transaction is about 2^45 bits/vB).
 */
const HUNDREDTHS_LIMIT = 2 ** 46

/**
 * The largest whole number of hundredths of a bit/vB that is not above
 * `feeRate`, a finite rate of 0 or more below `HUNDREDTHS_LIMIT`.
 * `feeRate * 100` can land on either side of a whole number in binary (0.29
 * * 100 is 28.999999999999996, 1.1 * 100 is 110.00000000000001), so the
 * candidate, at most one off either way, is checked against `feeRate`
 * itself: `n / 100` is the same number as the decimal `n / 100` a user types
 * or a provider sends, so a rate already in hundredths comes back unchanged.
 */
function floorFeeRateHundredths(feeRate: number): number {
  const hundredths = Math.floor(feeRate * 100)
  if ((hundredths + 1) / 100 <= feeRate) return hundredths + 1
  if (hundredths / 100 > feeRate) return hundredths - 1
  return hundredths
}

/**
 * A fee rate in bits/vB as the wallet shows it: rounded down to hundredths,
 * the Custom rate input's resolution, without trailing zeros, so a rate
 * shown is never higher than the rate paid. A rate worked out from a fee and
 * a size is seldom round: 955 bits for 3,817 vB (0.2502 bits/vB), a
 * one-input send at the 0.25 bits/vB relay floor, shows as 0.25, while 936
 * bits for the same size (0.2452 bits/vB) shows as 0.24, never as a 0.25
 * that the node's floor would refuse. A rate already in hundredths, as a
 * quote's are, shows as it is: 0.29 as 0.29, 1.15 as 1.15. A positive rate
 * below 0.01 shows as "<0.01", since 0 would read as no fee at all. A rate
 * that is no finite number of 0 or more, such as one lost on its way to the
 * popup, shows as "-".
 */
export function formatFeeRate(feeRate: number | null | undefined): string {
  if (typeof feeRate !== 'number' || !Number.isFinite(feeRate) || feeRate < 0) return '-'
  // Its whole part, which is not above it either.
  if (feeRate >= HUNDREDTHS_LIMIT) return String(Math.floor(feeRate))
  const hundredths = floorFeeRateHundredths(feeRate)
  if (hundredths === 0 && feeRate > 0) return '<0.01'
  return String(hundredths / 100)
}
