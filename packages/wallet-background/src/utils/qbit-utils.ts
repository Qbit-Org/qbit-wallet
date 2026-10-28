import { BigNumber } from 'bignumber.js'

export function amountToSatoshis(val: any) {
  const num = new BigNumber(val)
  return num.multipliedBy(100000000).toNumber()
}
