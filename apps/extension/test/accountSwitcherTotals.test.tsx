/**
 * The account switcher with the page's real store and totals hook, against a
 * wallet controller built by hand: the totals the background answers reach
 * the rows and the wallet headers, a kept total that is fresh is not read
 * again, and a read total that may be from before a transaction the wallet
 * submitted shows muted, with a name that says so.
 */
import { Provider } from 'react-redux';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountSwitcherSheet } from '@/ui/components/AccountSwitcher';
import { shortAddress } from '@/ui/utils';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { CHAINS_MAP, KeyringType, type QbitAccountTotal, type WalletKeyring } from '@qbit/wallet-shared';
import {
  accountActions,
  createAppStore,
  I18nContext,
  type I18nContextType,
  keyringsActions,
  WalletProvider
} from '@qbit/wallet-state';
import { AddressType, ChainType } from '@qbit/wallet-types';

// The real Input pulls in the whole component library, which needs the
// extension's browser APIs; a plain input with the same props stands in. No
// dialog opens here.
vi.mock('@/ui/components/Input', async () => {
  const React = await import('react');
  return {
    Input: ({ preset: _preset, ...props }: { preset?: string } & Record<string, unknown>) =>
      React.createElement('input', props)
  };
});

const UNIT = CHAINS_MAP[ChainType.QBIT_MAINNET]!.unit;

function account(keyringIndex: number, index: number) {
  return {
    type: KeyringType.QbitHdKeyring,
    address: `qb1zwallet${keyringIndex}account${index}`,
    brandName: 'Qbit',
    alianName: `Account ${index + 1}`,
    displayBrandName: 'Qbit',
    index,
    balance: 0,
    pubkey: `pubkey-${keyringIndex}-${index}`,
    key: `keyring_${keyringIndex}#${index}`,
    flag: 0
  };
}

function keyring(index: number, accountCount: number): WalletKeyring {
  return {
    key: `keyring_${index}`,
    index,
    type: KeyringType.QbitHdKeyring,
    addressType: AddressType.P2TR,
    accounts: Array.from({ length: accountCount }, (_, i) => account(index, i)),
    alianName: `Wallet ${index + 1}`,
    color: 'green',
    hdPath: ''
  } as WalletKeyring;
}

const answer = (address: string, totalBalance: number | null, fresh = false): QbitAccountTotal => ({
  address,
  chainType: ChainType.QBIT_MAINNET,
  totalBalance,
  readAt: totalBalance === null ? null : 1_700_000_000_000,
  fresh,
  error: false
});

const i18n: I18nContextType = {
  t: (key, substitutions) => (Array.isArray(substitutions) ? `${key}(${substitutions.join('|')})` : key),
  locale: 'en',
  supportedLocales: ['en'],
  localeNames: { en: 'English' },
  changeLocale: async () => undefined,
  isSpecialLocale: false
};

afterEach(() => {
  cleanup();
});

describe('AccountSwitcherSheet with the real store and totals hook', () => {
  it('shows the totals the background answers on the rows and the headers, reading only what is not fresh, and a read total that is not fresh as stale', async () => {
    const wallets = [keyring(0, 2), keyring(1, 1)];
    const [a0, a1] = wallets[0].accounts.map((item) => item.address);
    const [b0] = wallets[1].accounts.map((item) => item.address);
    const kept = {
      [a0]: answer(a0, 150_000_000, true),
      [a1]: answer(a1, 100),
      [b0]: answer(b0, null)
    };
    // b0's read began before a transaction the wallet submitted: its total
    // may be out of date, which the background says by not calling it fresh.
    const read = { [a1]: answer(a1, 200, true), [b0]: answer(b0, 1_250_000_000, false) };
    const wallet = {
      getKeyrings: vi.fn(async () => wallets),
      getQbitAccountTotals: vi.fn(async (addresses: string[]) => addresses.map((address) => kept[address])),
      readQbitAccountTotal: vi.fn(async (address: string) => read[address])
    };
    const store = createAppStore();
    store.dispatch(keyringsActions.setKeyrings(wallets));
    store.dispatch(keyringsActions.setCurrent(wallets[0]));
    store.dispatch(accountActions.setCurrent(wallets[0].accounts[0]));

    render(
      <Provider store={store}>
        <WalletProvider wallet={wallet as never}>
          <I18nContext.Provider value={i18n}>
            <AccountSwitcherSheet onClose={vi.fn()} />
          </I18nContext.Provider>
        </WalletProvider>
      </Provider>
    );

    const amount = (address: string) => screen.getByTestId(`account-balance-${address}`);
    await waitFor(() => expect(amount(b0).textContent).toBe(`12.5 ${UNIT}`));
    expect(amount(a0).textContent).toBe(`1.5 ${UNIT}`);
    expect(amount(a1).textContent).toBe(`0.000002 ${UNIT}`);
    expect(screen.getByTestId('wallet-total-keyring_0').textContent).toBe(`1.500002 ${UNIT}`);
    expect(screen.getByTestId('wallet-total-keyring_1').textContent).toBe(`12.5 ${UNIT}`);
    expect(
      within(screen.getByTestId('wallet-group-keyring_0')).getByText('account_switcher_account_count_other(2)')
    ).toBeTruthy();
    expect(screen.getByTestId(`account-row-${a0}`).getAttribute('aria-label')).toContain(
      `account_switcher_account_balance_label(Account 1|Wallet 1|`
    );

    // Fresh: shown as current. Not fresh: muted, and named as maybe out of
    // date, on the row and in its wallet's total.
    expect(amount(a1).getAttribute('data-stale')).toBeNull();
    expect(screen.getByTestId(`account-row-${a1}`).getAttribute('aria-label')).toContain(
      'account_switcher_account_balance_label('
    );
    expect(amount(b0).getAttribute('data-stale')).toBe('true');
    expect(screen.getByTestId(`account-row-${b0}`).getAttribute('aria-label')).toBe(
      `account_switcher_account_balance_stale_label(Account 1|Wallet 2|${shortAddress(b0)}|12.5 ${UNIT})`
    );
    expect(screen.getByTestId('wallet-total-keyring_1').getAttribute('data-stale')).toBe('true');
    expect(screen.getByTestId('wallet-total-stale-keyring_1').textContent).toBe('account_switcher_total_stale_note');
    expect(screen.getByTestId('wallet-total-keyring_0').getAttribute('data-stale')).toBeNull();
    expect(screen.queryByTestId('wallet-total-stale-keyring_0')).toBeNull();

    // One request for the kept totals, the current wallet first; the fresh
    // one is not read again.
    expect(wallet.getQbitAccountTotals).toHaveBeenCalledTimes(1);
    expect(wallet.getQbitAccountTotals).toHaveBeenCalledWith([a0, a1, b0]);
    expect(wallet.readQbitAccountTotal.mock.calls).toEqual([[a1], [b0]]);
    expect(store.getState().accounts.accountTotalsMap[ChainType.QBIT_MAINNET]?.[b0]?.totalBalance).toBe(1_250_000_000);
  });
});
