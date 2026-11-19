import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { formatBalance, numUtils } from '../src/num'

/** The text a balance of `satoshis` shows. */
const shown = (satoshis: number | string) => formatBalance(satoshis)?.text

describe('formatBalance', () => {
  it('is the one exported through numUtils', () => {
    expect(numUtils.formatBalance).toBe(formatBalance)
  })

  it('shows every part of a balance from its satoshis', () => {
    expect(formatBalance(11_859_183_137_906)).toEqual({
      whole: '118,591',
      decimals: '83137',
      text: '118,591.83137',
      exact: '118,591.83137906',
      truncated: true,
    })
    expect(formatBalance(0)).toEqual({
      whole: '0',
      decimals: '00000',
      text: '0.00000',
      exact: '0.00000000',
      truncated: false,
    })
    // Above zero, below the smallest amount five decimals show.
    expect(formatBalance(1)).toEqual({
      whole: '<0',
      decimals: '00001',
      text: '<0.00001',
      exact: '0.00000001',
      truncated: true,
    })
  })

  it('formats the listed amounts of satoshis', () => {
    const cases: [number, string, string][] = [
      [0, '0.00000', '0.00000000'],
      [1, '<0.00001', '0.00000001'],
      [999, '<0.00001', '0.00000999'],
      [1_000, '0.00001', '0.00001000'],
      [1_999, '0.00001', '0.00001999'],
      [99_999, '0.00099', '0.00099999'],
      [100_000, '0.00100', '0.00100000'],
      [99_999_999, '0.99999', '0.99999999'],
      [100_000_000, '1.00000', '1.00000000'],
      [123_456_789_012, '1,234.56789', '1,234.56789012'],
      [Number.MAX_SAFE_INTEGER, '90,071,992.54740', '90,071,992.54740991'],
    ]
    for (const [satoshis, text, exact] of cases) {
      const balance = formatBalance(satoshis)
      expect(balance?.text, String(satoshis)).toBe(text)
      expect(balance?.exact, String(satoshis)).toBe(exact)
      expect(balance?.truncated, String(satoshis)).toBe(exact.replace(/,/g, '') !== `${text}000`)
    }
  })

  it('separates every three digits of the whole part with a comma, and only those', () => {
    const coins = (whole: number) => whole * 100_000_000
    expect(shown(coins(999))).toBe('999.00000')
    expect(shown(coins(1_000))).toBe('1,000.00000')
    expect(shown(coins(999_999))).toBe('999,999.00000')
    expect(shown(coins(1_000_000))).toBe('1,000,000.00000')
    expect(shown(coins(21_000_000) + 12_345_000)).toBe('21,000,000.12345')
    // Past MAX_SAFE_INTEGER satoshis, given as a string.
    expect(shown('99999999999999999')).toBe('999,999,999.99999')
    expect(shown('100000000000000000')).toBe('1,000,000,000.00000')
  })

  it('truncates at the fifth decimal, never rounding up, at every place', () => {
    // Each amount is one satoshi short of the next step up at a shown place.
    expect(shown(9_999)).toBe('0.00009')
    expect(shown(99_999)).toBe('0.00099')
    expect(shown(999_999)).toBe('0.00999')
    expect(shown(9_999_999)).toBe('0.09999')
    expect(shown(99_999_999)).toBe('0.99999')
    expect(shown(199_999_999)).toBe('1.99999')
    expect(shown(99_999_999_999)).toBe('999.99999')
    expect(shown(99_999_999_999_999)).toBe('999,999.99999')
    expect(shown('99999999999999999')).toBe('999,999,999.99999')
    // Digits past the fifth are dropped whatever they are.
    expect(shown(1_000_001)).toBe('0.01000')
    expect(shown(1_000_500)).toBe('0.01000')
    expect(shown(1_000_999)).toBe('0.01000')
    expect(shown(1_001_000)).toBe('0.01001')
  })

  it('never shows a balance above zero as zero', () => {
    for (const satoshis of [1, 2, 500, 998, 999]) {
      expect(formatBalance(satoshis)).toMatchObject({
        whole: '<0',
        decimals: '00001',
        text: '<0.00001',
      })
    }
    expect(shown(1_000)).toBe('0.00001')
  })

  it('marks as truncated exactly the balances whose dropped digits are not all zero', () => {
    expect(formatBalance(25_000_000)?.truncated).toBe(false)
    expect(formatBalance(25_000_001)?.truncated).toBe(true)
    expect(formatBalance(25_001_000)?.truncated).toBe(false)
    expect(formatBalance(1)?.truncated).toBe(true)
  })

  it('takes a string of digits as it takes a number', () => {
    expect(formatBalance('11859183137906')).toEqual(formatBalance(11_859_183_137_906))
    expect(formatBalance('0')).toEqual(formatBalance(0))
    // Past what a number holds exactly, a string stays exact.
    expect(formatBalance('9007199254740993')?.exact).toBe('90,071,992.54740993')
    expect(formatBalance('123456789012345678901234')?.exact).toBe('1,234,567,890,123,456.78901234')
  })

  it('never writes an exponent', () => {
    const balance = formatBalance('1000000000000000000000000000000')
    expect(balance?.text).toBe('10,000,000,000,000,000,000,000.00000')
    expect(balance?.exact).toBe('10,000,000,000,000,000,000,000.00000000')
    expect(formatBalance(1)?.exact).not.toMatch(/e/i)
  })

  it('has no floating-point artefacts', () => {
    // 0.1 + 0.2 in floating point is 0.30000000000000004.
    expect(formatBalance(30_000_000)?.exact).toBe('0.30000000')
    expect(formatBalance(10_000_000 + 20_000_000)?.text).toBe('0.30000')
    // 0.29 * 1e8 in floating point is 28999999.999999996.
    expect(formatBalance(29_000_000)?.text).toBe('0.29000')
    expect(formatBalance(1_150_000_005)?.exact).toBe('11.50000005')
    expect(formatBalance(Number.MAX_SAFE_INTEGER - 1)?.exact).toBe('90,071,992.54740990')
  })

  it('formats negative zero as zero', () => {
    expect(formatBalance(-0)).toEqual(formatBalance(0))
  })

  it('gives no balance for a negative amount, which no balance is', () => {
    for (const value of [-1, -1_999, -100_000_000, '-5']) {
      expect(formatBalance(value), String(value)).toBeNull()
    }
  })

  it('gives no balance for what is not a whole number of satoshis', () => {
    const values: (number | string)[] = [
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      // A number past MAX_SAFE_INTEGER may already have lost its last digits.
      Number.MAX_SAFE_INTEGER + 1,
      '1.5',
      '',
      ' 1',
      '1 ',
      '1e3',
      '0x10',
      '--',
      '****',
      'NaN',
    ]
    for (const value of values) {
      expect(formatBalance(value), String(value)).toBeNull()
    }
  })

  it('refuses a digit string longer than 40 digits, which no amount reaches', () => {
    expect(formatBalance('9'.repeat(40))?.exact).toBe(
      `${'9'.repeat(32).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.99999999`
    )
    // 10^39 satoshis are 10^31 coins.
    expect(formatBalance('1' + '0'.repeat(39))?.text).toBe(`10${',000'.repeat(10)}.00000`)
    expect(formatBalance('1' + '0'.repeat(40))).toBeNull()
    expect(formatBalance('9'.repeat(41))).toBeNull()
  })

  it('refuses a digit string with leading zeros', () => {
    for (const value of ['007', '00', '01', '0001000']) {
      expect(formatBalance(value), value).toBeNull()
    }
    expect(formatBalance('0')?.text).toBe('0.00000')
    expect(formatBalance('1000')?.text).toBe('0.00001')
  })

  // An object that only looks like a BigNumber, with a coefficient that is
  // not whole, once passed every check and then looped for ever in the
  // division. A loop cannot be timed out in this process, so the calls run in
  // a child process that is killed if it has not answered within 8 s, as is
  // a string of digits far too long for any amount.
  it('refuses any object, a BigNumber or a look-alike, and ten million digits, without throwing or hanging', () => {
    const script = `
      const { BigNumber } = await import('bignumber.js')
      const { formatBalance } = await import(${JSON.stringify(new URL('../src/num.ts', import.meta.url).href)})
      const values = [
        { _isBigNumber: true, s: 1, e: 0, c: [1.5] },
        new BigNumber(5),
        new BigNumber('11859183137906'),
        new BigNumber(-0),
        { _isBigNumber: true },
        { _isBigNumber: true, c: 5, e: 0, s: 1 },
        { _isBigNumber: true, c: [5], e: 'x', s: 1 },
        {},
        null,
        undefined,
        true,
        [5],
        // Ten million digits: Infinity to bignumber.js, and minutes of work.
        '1'.repeat(10_000_000),
      ]
      const answers = values.map(value => {
        try {
          return formatBalance(value)
        } catch (error) {
          return 'threw ' + String(error)
        }
      })
      console.log(JSON.stringify(answers))
    `
    const run = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        encoding: 'utf8',
        timeout: 8_000,
      }
    )
    expect(run.error, 'the calls did not finish within 8 s').toBeUndefined()
    expect(run.status, run.stderr).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual(Array(13).fill(null))
  }, 20_000)
})

describe('satoshisToAmount', () => {
  it('keeps the exact amount with eight decimals and no separators', () => {
    expect(numUtils.satoshisToAmount(11_859_183_137_906)).toBe('118591.83137906')
    expect(numUtils.satoshisToAmount(1_999)).toBe('0.00001999')
    expect(numUtils.satoshisToAmount(0)).toBe('0.00000000')
  })
})
