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

/** A total's texts, from one formatting of its sats: see `totalTexts`. */
export interface TotalTexts {
  /** As every balance shows: "1,234.56789 QBT", "0.00000 QBT", "<0.00001 QBT"; `--` for no balance. */
  shown: string;
  /** Exactly, all eight decimals, for the hover text and a screen reader: "1,234.56789012 QBT". */
  exact?: string;
}

/**
 * `sats` as every balance shows (commas between groups of three digits, five
 * decimals, truncated, then the unit) and exactly, with all eight decimals.
 * What is no balance shows `--`, with no exact amount.
 */
export function totalTexts(sats: number, unit: string): TotalTexts {
  const balance = numUtils.formatBalance(sats);
  return balance ? { shown: `${balance.text} ${unit}`, exact: `${balance.exact} ${unit}` } : { shown: '--' };
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
