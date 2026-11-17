import { numUtils } from '@qbit/base-utils';
import { isSatoshiAmount } from '@qbit/wallet-state';

/** What the switcher knows of one account's total; see `useAccountSwitcherTotals`. */
export interface AccountTotalState {
  totalBalance: number | null;
  stale: boolean;
  pending: boolean;
}

/** What a row or a wallet header shows in the place of a total. */
export type TotalDisplay =
  | { kind: 'hidden' }
  | { kind: 'pending' }
  | { kind: 'unknown' }
  | { kind: 'amount'; sats: number; stale: boolean };

/**
 * `sats` in the wallet's unit, without the trailing zeros of the fraction,
 * then the unit: "12.5 QBT", "0 QBT".
 */
export function formatTotal(sats: number, unit: string): string {
  const amount = numUtils.satoshisToAmount(sats);
  const trimmed = amount.includes('.') ? amount.replace(/\.?0+$/, '') : amount;
  return `${trimmed} ${unit}`;
}

/**
 * An account's row: its total while one is known, also while it is read
 * again; the placeholder while none is and an answer is still to come; `--`
 * once none came.
 */
export function accountTotalDisplay(hidden: boolean, state: AccountTotalState | undefined): TotalDisplay {
  if (hidden) return { kind: 'hidden' };
  if (state && isSatoshiAmount(state.totalBalance)) {
    return { kind: 'amount', sats: state.totalBalance, stale: state.stale };
  }
  return state?.pending ? { kind: 'pending' } : { kind: 'unknown' };
}

/**
 * A wallet's header: the sum of all its accounts' totals, in sats, only once
 * every one of them has a total (a stale one counts, and makes the sum
 * stale). While one has none and an answer is still to come, the
 * placeholder; once none is to come, `--`.
 */
export function walletTotalDisplay(hidden: boolean, accounts: TotalDisplay[]): TotalDisplay {
  if (hidden) return { kind: 'hidden' };
  let sats = 0;
  let stale = false;
  let unknown = false;
  for (const account of accounts) {
    if (account.kind === 'pending') return { kind: 'pending' };
    if (account.kind !== 'amount') {
      unknown = true;
      continue;
    }
    sats += account.sats;
    stale = stale || account.stale;
  }
  if (unknown || !isSatoshiAmount(sats)) return { kind: 'unknown' };
  return { kind: 'amount', sats, stale };
}
