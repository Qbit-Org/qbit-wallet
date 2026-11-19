import { BigNumber } from 'bignumber.js'
export function numberWithCommas(value: string, maxFixed: number, isFixed = false) {
  const [integerPart, decimalPart] = value.toString().split('.')
  const integerPartWithCommas = integerPart!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  if (maxFixed === 0) {
    // no decimal
    return integerPartWithCommas
  } else if (maxFixed > 0) {
    if (isFixed) {
      // fixed
      return `${integerPartWithCommas}.${(decimalPart || '')
        .substring(0, maxFixed)
        .padEnd(maxFixed, '0')}`
    } else {
      return decimalPart
        ? `${integerPartWithCommas}.${decimalPart.substring(
            0,
            Math.min(maxFixed, decimalPart.length)
          )}`
        : integerPartWithCommas
    }
  } else {
    // fixed <0 show all decimal
    return decimalPart ? `${integerPartWithCommas}.${decimalPart}` : integerPartWithCommas
  }
}

export function showLongNumber(num: string | number | undefined, maxFixed = 8, isFixed = false) {
  if (!num || new BigNumber(num).isZero()) return '0'
  if (Math.abs(num as number) < 0.000001 && maxFixed <= 6) {
    let temp = '0.'
    for (let i = 0; i < maxFixed; i += 1) {
      temp += '0'
    }
    return temp
  }
  return numberWithCommas(num.toString(), maxFixed, isFixed)
}

export function satoshisToAmount(val: number) {
  const num = new BigNumber(val)
  return num.dividedBy(100000000).toFixed(8)
}

export function amountToSatoshis(val: any) {
  const num = new BigNumber(val)
  return num.multipliedBy(100000000).toNumber()
}

/** A balance as a screen shows it; see `formatBalance`. */
export interface FormattedBalance {
  /** The whole coins with a comma between groups of three digits ("118,591"); "<0" below 0.00001. */
  whole: string
  /** The first five decimals ("83137"); "00001" below 0.00001. */
  decimals: string
  /** `whole` and `decimals` joined by the point: "118,591.83137", "<0.00001". */
  text: string
  /** The exact amount, with all eight decimals and the same commas: "118,591.83137906". */
  exact: string
  /** Whether `text` leaves out decimals of `exact` that are not zero. */
  truncated: boolean
}

const SATOSHIS_PER_COIN = new BigNumber(100000000)
const BALANCE_DECIMALS = 5

/** `value` as a whole, non-negative number of satoshis, or null when it is none. */
function balanceSatoshis(value: number | string): BigNumber | null {
  if (typeof value === 'number') {
    // Past MAX_SAFE_INTEGER a number may have lost its last digits already.
    return Number.isSafeInteger(value) && value >= 0 ? new BigNumber(value).abs() : null
  }
  if (typeof value === 'string') {
    // Digits only, without leading zeros, and at most 40 of them: no amount
    // comes near, and a string of millions of digits would take minutes to
    // format, or turn into Infinity.
    return /^(0|[1-9]\d{0,39})$/.test(value) ? new BigNumber(value) : null
  }
  // Any object, a BigNumber or one that only looks like one included: its
  // inner digits are not checked here, and a look-alike's can make the
  // division below loop for ever. A caller with a whole-number BigNumber
  // passes its digits (`toFixed(0)`).
  return null
}

/**
 * A balance of `satoshis` as the wallet shows how much an account holds: the
 * whole coins with a comma between groups of three digits, in every locale,
 * and five decimals, truncated, never rounded up, so it never shows more than
 * the account holds: 11859183137906 is "118,591.83137", 1999 is "0.00001", 0
 * is "0.00000". An amount above 0 and below 0.00001 is "<0.00001", never
 * zero. `exact` keeps all eight decimals for a hover text or a screen reader.
 *
 * Integer arithmetic only, from a whole number of satoshis: a safe integer or
 * a string of at most 40 digits without leading zeros. Anything else, a
 * negative amount or any object included, is no balance and gives null, for
 * the caller to show as unknown. Amounts that are sent, compared or computed
 * with stay `satoshisToAmount`'s.
 */
export function formatBalance(satoshis: number | string): FormattedBalance | null {
  const value = balanceSatoshis(satoshis)
  if (value === null) return null
  const whole = numberWithCommas(value.idiv(SATOSHIS_PER_COIN).toFixed(0), 0)
  const fraction = value.mod(SATOSHIS_PER_COIN).toFixed(0).padStart(8, '0')
  const exact = `${whole}.${fraction}`
  const truncated = /[1-9]/.test(fraction.slice(BALANCE_DECIMALS))
  const decimals = fraction.slice(0, BALANCE_DECIMALS)
  if (whole === '0' && /^0+$/.test(decimals) && truncated) {
    return { whole: '<0', decimals: '00001', text: '<0.00001', exact, truncated }
  }
  return { whole, decimals, text: `${whole}.${decimals}`, exact, truncated }
}

export const numUtils = {
  numberWithCommas,
  showLongNumber,
  satoshisToAmount,
  amountToSatoshis,
  formatBalance,
}
