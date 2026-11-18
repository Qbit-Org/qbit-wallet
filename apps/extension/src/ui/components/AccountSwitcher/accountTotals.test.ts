import { describe, expect, it } from 'vitest';

import { accountTotalDisplay, totalTexts, walletTotalDisplay } from './accountTotals';

describe('totalTexts', () => {
  const shown = (sats: number) => totalTexts(sats, 'QBT').shown;
  const exact = (sats: number) => totalTexts(sats, 'QBT').exact;

  it('shows a total as a balance: commas, five decimals truncated, then the unit', () => {
    expect(shown(0)).toBe('0.00000 QBT');
    expect(shown(1_250_000_000)).toBe('12.50000 QBT');
    expect(shown(1_000_000_000)).toBe('10.00000 QBT');
    expect(shown(100_000_000_000)).toBe('1,000.00000 QBT');
    expect(shown(1)).toBe('<0.00001 QBT');
    expect(shown(1_999)).toBe('0.00001 QBT');
    expect(shown(2_100_000_012_345_678)).toBe('21,000,000.12345 QBT');
  });

  it('keeps the exact amount: all eight decimals, with the commas and the unit', () => {
    expect(exact(0)).toBe('0.00000000 QBT');
    expect(exact(1)).toBe('0.00000001 QBT');
    expect(exact(2_100_000_012_345_678)).toBe('21,000,000.12345678 QBT');
  });

  it('shows -- for what is no balance, with no exact amount', () => {
    for (const sats of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(totalTexts(sats, 'QBT'), String(sats)).toEqual({ shown: '--' });
    }
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
