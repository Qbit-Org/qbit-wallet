import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Account, QbitRecoveryState, WalletKeyring } from '@qbit/wallet-shared';
import { KeyringType } from '@qbit/wallet-shared';
import { useCurrentAccount, useCurrentKeyring, useI18n, useTools } from '@qbit/wallet-state';
import { shortAddress } from '@/ui/utils';

import AccountSelect from './index';

vi.mock('@qbit/wallet-state', () => ({
  useCurrentAccount: vi.fn(),
  useCurrentKeyring: vi.fn(),
  useI18n: vi.fn(),
  useTools: vi.fn()
}));

// The sheet has its own tests; here it only has to open and close.
vi.mock('@/ui/components/AccountSwitcher', async () => {
  const React = await import('react');
  return {
    AccountSwitcherSheet: ({ onClose }: { onClose: () => void }) =>
      React.createElement('button', { 'data-testid': 'switch-account-sheet', onClick: onClose }, 'sheet')
  };
});

const account: Account = {
  key: 'keyring_3#1',
  index: 1,
  type: KeyringType.QbitHdKeyring,
  address: 'qb1zcaq3examplecurrentaccountaddressmql2zw3m',
  pubkey: 'pubkey',
  alianName: 'Account 2',
  flag: 0
};

function keyring(overrides: Partial<WalletKeyring> = {}): WalletKeyring {
  return {
    key: 'keyring_3',
    index: 3,
    type: KeyringType.QbitHdKeyring,
    addressType: 9,
    accounts: [account],
    alianName: 'Qbit HD Wallet #4',
    color: 'teal',
    hdPath: '',
    ...overrides
  };
}

const recovery = (status: QbitRecoveryState['status']): QbitRecoveryState => ({
  status,
  acknowledgement: 'required',
  counterConfidence: 'local',
  knownOnChainSignatures: 0
});

describe('AccountSelect', () => {
  const copyToClipboard = vi.fn();

  beforeEach(() => {
    vi.mocked(useCurrentAccount).mockReturnValue(account);
    vi.mocked(useCurrentKeyring).mockReturnValue(keyring());
    vi.mocked(useI18n).mockReturnValue({
      t: (key: string, substitutions?: string[]) => (substitutions ? `${key}(${substitutions.join('|')})` : key)
    } as unknown as ReturnType<typeof useI18n>);
    vi.mocked(useTools).mockReturnValue({ copyToClipboard } as unknown as ReturnType<typeof useTools>);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('names the wallet above the account, with its tile and the short address', () => {
    render(<AccountSelect />);

    const walletName = screen.getByTestId('account-select-wallet-name');
    const accountName = screen.getByTestId('account-select-account-name');
    expect(walletName.textContent).toBe('Qbit HD Wallet #4');
    expect(accountName.textContent).toBe('Account 2');
    expect(walletName.compareDocumentPosition(accountName) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const tile = screen.getByTestId('account-select-wallet-tile');
    expect(tile.getAttribute('data-color')).toBe('teal');
    expect(tile.getAttribute('aria-hidden')).toBe('true');
    expect(tile.style.width).toBe('28px');
    expect(tile.style.height).toBe('28px');
    expect(screen.getByTestId('account-select-copy').textContent).toBe(shortAddress(account.address));

    // The open button over the card names both too.
    const card = screen.getByTestId('account-select');
    expect(screen.getByRole('button', { name: 'account_switcher_open_label(Account 2|Qbit HD Wallet #4)' })).toBe(card);
    expect(card.getAttribute('title')).toBe('Qbit HD Wallet #4\nAccount 2');
  });

  // Which element holds what; where the lines fall is layout, which the e2e scenario checks.
  it('shows the tags after the wallet name on the first line, and the account name alone on the next', () => {
    vi.mocked(useCurrentKeyring).mockReturnValue(keyring({ qbitRecovery: recovery('seed-only-restored') }));
    render(<AccountSelect />);

    const walletName = screen.getByTestId('account-select-wallet-name');
    const walletLine = walletName.parentElement;
    expect(Array.from(walletLine?.children ?? [])).toEqual([
      walletName,
      screen.getByTestId('account-select-tag-recovered')
    ]);
    const accountName = screen.getByTestId('account-select-account-name');
    expect(walletLine?.nextElementSibling).toBe(accountName);
    expect(accountName.children).toHaveLength(0);
    expect(accountName.textContent).toBe('Account 2');
    const copy = screen.getByTestId('account-select-copy');
    expect(accountName.nextElementSibling).toBe(copy);
    expect(copy.nextElementSibling).toBeNull();
  });

  it('keeps only the name on the wallet line of a wallet without tags', () => {
    render(<AccountSelect />);

    // Nothing follows the name, so the line's gap adds no space after it.
    const walletName = screen.getByTestId('account-select-wallet-name');
    expect(Array.from(walletName.parentElement?.children ?? [])).toEqual([walletName]);
    expect(screen.queryAllByTestId(/^account-select-tag-/)).toHaveLength(0);
  });

  it('shows the slot color when the store has no color yet', () => {
    vi.mocked(useCurrentKeyring).mockReturnValue(keyring({ color: undefined as unknown as 'teal', index: 9 }));
    render(<AccountSelect />);

    expect(screen.getByTestId('account-select-wallet-tile').getAttribute('data-color')).toBe('blue');
  });

  it('copies the address from the address control without opening the switcher', () => {
    render(<AccountSelect />);

    fireEvent.click(screen.getByTestId('account-select-copy'));

    expect(copyToClipboard).toHaveBeenCalledWith(account.address);
    expect(screen.queryByTestId('switch-account-sheet')).toBeNull();
  });

  it('opens the switcher from the rest of the card and gives focus back when it closes', () => {
    render(<AccountSelect />);
    const card = screen.getByTestId('account-select');

    expect(card.tagName).toBe('BUTTON');
    expect(card.getAttribute('aria-expanded')).toBe('false');
    expect(card.getAttribute('aria-label')).toBe('account_switcher_open_label(Account 2|Qbit HD Wallet #4)');
    fireEvent.click(card);

    expect(screen.getByTestId('switch-account-sheet')).toBeTruthy();
    expect(card.getAttribute('aria-expanded')).toBe('true');
    expect(copyToClipboard).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('switch-account-sheet'));
    expect(screen.queryByTestId('switch-account-sheet')).toBeNull();
    expect(document.activeElement).toBe(card);
  });

  it('shows the full wallet and account names on hover over the part that opens the switcher', () => {
    vi.mocked(useCurrentKeyring).mockReturnValue(keyring({ alianName: 'WWWWWWWWWWWWWWWWWWWW' }));
    vi.mocked(useCurrentAccount).mockReturnValue({ ...account, alianName: 'MMMMMMMMMMMMMMMMMMMM' });
    render(<AccountSelect />);

    // The open button lies over the names, so the hover lands on it.
    const card = screen.getByTestId('account-select');
    expect(card.getAttribute('title')).toBe('WWWWWWWWWWWWWWWWWWWW\nMMMMMMMMMMMMMMMMMMMM');
    // Its accessible name stays as it was.
    expect(card.getAttribute('aria-label')).toBe(
      'account_switcher_open_label(MMMMMMMMMMMMMMMMMMMM|WWWWWWWWWWWWWWWWWWWW)'
    );
  });

  it('labels the copy control with the account it copies', () => {
    render(<AccountSelect />);

    expect(screen.getByTestId('account-select-copy').getAttribute('aria-label')).toBe(
      'account_switcher_copy_address_label(Account 2)'
    );
  });

  it('tags the wallet from the recovery state the home screen fetched, not the stale snapshot', () => {
    vi.mocked(useCurrentKeyring).mockReturnValue(keyring({ qbitRecovery: recovery('seed-only-restored') }));
    const { rerender } = render(<AccountSelect recoveryState={recovery('migrated')} />);

    expect(screen.getByTestId('account-select-tag-archived').textContent).toBe('wallet_tag_archived');
    expect(screen.queryByTestId('account-select-tag-recovered')).toBeNull();

    rerender(<AccountSelect recoveryState={recovery('migrating')} />);
    expect(screen.getByTestId('account-select-tag-recovered').textContent).toBe('wallet_tag_recovered');

    rerender(<AccountSelect recoveryState={recovery('clean')} />);
    expect(screen.queryAllByTestId(/^account-select-tag-/)).toHaveLength(0);
  });

  it('falls back to the snapshot when no fresh state was given', () => {
    vi.mocked(useCurrentKeyring).mockReturnValue(keyring({ qbitRecovery: recovery('seed-only-restored') }));
    render(<AccountSelect />);

    expect(screen.getByTestId('account-select-tag-recovered')).toBeTruthy();
  });

  it.each([
    [KeyringType.ReadonlyKeyring, 'account-select-tag-read-only', 'wallet_tag_read_only'],
    [KeyringType.WatchAddressKeyring, 'account-select-tag-read-only', 'wallet_tag_read_only'],
    [KeyringType.ColdWalletKeyring, 'account-select-tag-cold', 'linked_to_cold_wallet']
  ])('tags a %s wallet', (type, testId, label) => {
    vi.mocked(useCurrentKeyring).mockReturnValue(keyring({ type }));
    render(<AccountSelect />);

    expect(screen.getByTestId(testId).textContent).toBe(label);
  });
});
