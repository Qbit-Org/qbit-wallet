import { describe, expect, it } from 'vitest';

import { accountTotalDisplay, formatTotal, walletTotalDisplay } from './accountTotals';

describe('formatTotal', () => {
  it('drops the trailing zeros of the fraction, and the point with them', () => {
    expect(formatTotal(0, 'QBT')).toBe('0 QBT');
    expect(formatTotal(1_250_000_000, 'QBT')).toBe('12.5 QBT');
    expect(formatTotal(1_000_000_000, 'QBT')).toBe('10 QBT');
    expect(formatTotal(100_000_000_000, 'QBT')).toBe('1000 QBT');
    expect(formatTotal(1, 'QBT')).toBe('0.00000001 QBT');
    expect(formatTotal(2_100_000_012_345_678, 'QBT')).toBe('21000000.12345678 QBT');
  });
});

describe('accountTotalDisplay', () => {
  it('shows a known total, pending or not, and otherwise the placeholder or unknown', () => {
    expect(accountTotalDisplay(false, { totalBalance: 5, stale: false, pending: true })).toEqual({
      kind: 'amount',
      sats: 5,
      stale: false
    });
    expect(accountTotalDisplay(false, { totalBalance: null, stale: false, pending: true })).toEqual({
      kind: 'pending'
    });
    expect(accountTotalDisplay(false, { totalBalance: null, stale: false, pending: false })).toEqual({
      kind: 'unknown'
    });
    expect(accountTotalDisplay(false, undefined)).toEqual({ kind: 'unknown' });
    expect(accountTotalDisplay(true, { totalBalance: 5, stale: false, pending: false })).toEqual({ kind: 'hidden' });
  });
});

describe('walletTotalDisplay', () => {
  const amount = (sats: number, stale = false) => ({ kind: 'amount', sats, stale }) as const;

  it('sums in sats once every account has a total', () => {
    expect(walletTotalDisplay(false, [amount(1), amount(2, true), amount(3)])).toEqual(amount(6, true));
  });

  it('waits while one is on its way, and is unknown once one stays unknown', () => {
    expect(walletTotalDisplay(false, [amount(1), { kind: 'unknown' }, { kind: 'pending' }])).toEqual({
      kind: 'pending'
    });
    expect(walletTotalDisplay(false, [amount(1), { kind: 'unknown' }])).toEqual({ kind: 'unknown' });
  });

  it('is unknown when the sum is past what a number holds exactly', () => {
    expect(walletTotalDisplay(false, [amount(Number.MAX_SAFE_INTEGER), amount(1)])).toEqual({ kind: 'unknown' });
  });

  it('is hidden while balances are', () => {
    expect(walletTotalDisplay(true, [amount(1)])).toEqual({ kind: 'hidden' });
  });
});
