import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Account, QbitRecoveryState, WalletKeyring } from '@qbit/wallet-shared';
import { KeyringType, WALLET_COLOR_KEYS } from '@qbit/wallet-shared';
import { shortAddress } from '@/ui/utils';

import { AccountSwitcherSheet } from './AccountSwitcherSheet';

interface StoreState {
  keyrings: WalletKeyring[];
  currentKeyring: WalletKeyring;
  currentAccount: Account;
}
interface Action {
  type: string;
  payload: unknown;
}

// A stand-in for the wallet-state store: the same slices and the actions the
// sheet dispatches, applied the way the real reducers apply them.
const harness = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const store = {
    state: { keyrings: [], currentKeyring: {}, currentAccount: {} } as unknown as StoreState,
    actions: [] as Action[]
  };
  const renameAccount = (account: Account, renamed: Account): Account =>
    account.key === renamed.key ? { ...account, alianName: renamed.alianName } : account;
  const reduce = (state: StoreState, action: Action): StoreState => {
    const keyring = action.payload as WalletKeyring;
    const updateKeyring = (patch: (k: WalletKeyring) => WalletKeyring) => ({
      ...state,
      keyrings: state.keyrings.map((k) => (k.key === keyring.key ? patch(k) : k)),
      currentKeyring: state.currentKeyring.key === keyring.key ? patch(state.currentKeyring) : state.currentKeyring
    });
    switch (action.type) {
      case 'keyrings/setKeyrings':
        return { ...state, keyrings: action.payload as WalletKeyring[] };
      case 'keyrings/setCurrent':
        return { ...state, currentKeyring: keyring };
      case 'keyrings/updateKeyringName':
        return updateKeyring((k) => ({ ...k, alianName: keyring.alianName }));
      case 'keyrings/updateKeyringColor':
        return updateKeyring((k) => ({ ...k, color: keyring.color }));
      case 'keyrings/updateAccountName': {
        const renamed = action.payload as Account;
        return {
          ...state,
          keyrings: state.keyrings.map((k) => ({ ...k, accounts: k.accounts.map((a) => renameAccount(a, renamed)) })),
          currentKeyring: {
            ...state.currentKeyring,
            accounts: state.currentKeyring.accounts.map((a) => renameAccount(a, renamed))
          }
        };
      }
      case 'accounts/setCurrent':
        return { ...state, currentAccount: action.payload as Account };
      case 'accounts/updateAccountName':
        return { ...state, currentAccount: renameAccount(state.currentAccount, action.payload as Account) };
      default:
        return state;
    }
  };
  return {
    store,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset(state: StoreState) {
      store.state = state;
      store.actions = [];
    },
    dispatch(action: Action) {
      store.actions.push(action);
      store.state = reduce(store.state, action);
      listeners.forEach((listener) => listener());
      return action;
    },
    t: (key: string, substitutions?: string[]) => (substitutions ? `${key}(${substitutions.join('|')})` : key),
    wallet: {} as Record<string, ReturnType<typeof vi.fn>>,
    tools: {} as Record<string, ReturnType<typeof vi.fn>>,
    nav: {} as Record<string, ReturnType<typeof vi.fn>>
  };
});

vi.mock('@qbit/wallet-state', async () => {
  const React = await import('react');
  const useSelect = <T,>(pick: (state: StoreState) => T) =>
    React.useSyncExternalStore(harness.subscribe, () => pick(harness.store.state));
  const action = (type: string) => (payload: unknown) => ({ type, payload });
  return {
    accountActions: { setCurrent: action('accounts/setCurrent'), updateAccountName: action('accounts/updateAccountName') },
    keyringsActions: {
      setKeyrings: action('keyrings/setKeyrings'),
      setCurrent: action('keyrings/setCurrent'),
      updateKeyringName: action('keyrings/updateKeyringName'),
      updateKeyringColor: action('keyrings/updateKeyringColor'),
      updateAccountName: action('keyrings/updateAccountName')
    },
    useAppDispatch: () => harness.dispatch,
    useCurrentAccount: () => useSelect((state) => state.currentAccount),
    useCurrentKeyring: () => useSelect((state) => state.currentKeyring),
    useKeyrings: () => useSelect((state) => state.keyrings),
    useI18n: () => ({ t: harness.t, locale: 'en' }),
    useNavigation: () => harness.nav,
    useTools: () => harness.tools,
    useWallet: () => harness.wallet
  };
});

// The real Input pulls in the whole component library, which needs the
// extension's browser APIs; a plain input with the same props stands in.
vi.mock('@/ui/components/Input', async () => {
  const React = await import('react');
  return {
    Input: ({ preset: _preset, ...props }: { preset?: string } & Record<string, unknown>) =>
      React.createElement('input', props)
  };
});

function makeAccount(keyringIndex: number, index: number, type: string): Account {
  return {
    key: `keyring_${keyringIndex}#${index}`,
    index,
    type,
    address: `qb1zwallet${keyringIndex}account${index}tailaddress${keyringIndex}${index}`,
    pubkey: `pubkey-${keyringIndex}-${index}`,
    alianName: `Account ${index + 1}`,
    flag: 0
  };
}

function makeKeyring(
  index: number,
  type: string,
  accountCount: number,
  extra: Partial<WalletKeyring> & { isCorrupted?: boolean } = {}
): WalletKeyring {
  return {
    key: `keyring_${index}`,
    index,
    type,
    addressType: 9,
    accounts: Array.from({ length: accountCount }, (_, i) => makeAccount(index, i, type)),
    alianName: `Wallet ${index + 1}`,
    color: WALLET_COLOR_KEYS[index % WALLET_COLOR_KEYS.length],
    hdPath: '',
    ...extra
  } as WalletKeyring;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const recovery = (status: QbitRecoveryState['status']): QbitRecoveryState => ({
  status,
  acknowledgement: 'required',
  counterConfidence: 'local',
  knownOnChainSignatures: 0
});

async function renderSheet(keyrings: WalletKeyring[], current = { keyring: 0, account: 0 }) {
  const currentKeyring = keyrings[current.keyring];
  harness.reset({ keyrings, currentKeyring, currentAccount: currentKeyring.accounts[current.account] });
  const onClose = vi.fn();
  const result = render(<AccountSwitcherSheet onClose={onClose} />);
  await screen.findByTestId('switch-account-sheet');
  // Let the read made on opening settle.
  await act(async () => {
    await Promise.resolve();
  });
  return { ...result, onClose };
}

const dispatched = (type: string) => harness.store.actions.filter((action) => action.type === type);
const rowIds = () =>
  screen.queryAllByTestId(/^account-row-/).map((row) => row.getAttribute('data-testid')?.replace('account-row-', ''));
const menuItemIds = () => screen.getAllByRole('menuitem').map((item) => item.getAttribute('data-testid'));

beforeEach(() => {
  harness.wallet = {
    getKeyrings: vi.fn(async () => harness.store.state.keyrings),
    changeKeyring: vi.fn(async () => undefined),
    getCurrentAccount: vi.fn(),
    setKeyringAlianName: vi.fn(async (keyring: WalletKeyring, name: string) => ({ ...keyring, alianName: name })),
    setAccountAlianName: vi.fn(async (account: Account, name: string) => ({ ...account, alianName: name })),
    setKeyringColor: vi.fn(async (keyring: WalletKeyring, color: string) => ({ ...keyring, color })),
    removeKeyring: vi.fn(),
    isUnlocked: vi.fn(async () => true)
  };
  harness.tools = { toastError: vi.fn(), toastSuccess: vi.fn(), toastWarning: vi.fn(), copyToClipboard: vi.fn() };
  harness.nav = { navigate: vi.fn() };
});

afterEach(() => {
  cleanup();
});

describe('AccountSwitcherSheet layout', () => {
  it('lists every wallet in wallet order with its accounts, tile, name and count', async () => {
    const keyrings = [
      makeKeyring(0, KeyringType.QbitHdKeyring, 2),
      makeKeyring(3, KeyringType.HdKeyring, 1, { color: 'pink' }),
      makeKeyring(5, KeyringType.QbitHdKeyring, 3)
    ];
    await renderSheet(keyrings);

    const groups = screen.getAllByTestId(/^wallet-group-/).map((group) => group.getAttribute('data-testid'));
    expect(groups).toEqual(['wallet-group-keyring_0', 'wallet-group-keyring_3', 'wallet-group-keyring_5']);
    expect(screen.getByText('switch_account')).toBeTruthy();
    expect(screen.getByTestId('wallet-name-keyring_3').textContent).toBe('Wallet 4');
    expect(screen.getByTestId('wallet-tile-keyring_3').getAttribute('data-color')).toBe('pink');
    expect(screen.getByTestId('wallet-tile-keyring_0').getAttribute('data-color')).toBe('green');
    const group0 = within(screen.getByTestId('wallet-group-keyring_0'));
    expect(group0.getByText('account_switcher_account_count_other(2)')).toBeTruthy();
    expect(within(screen.getByTestId('wallet-group-keyring_3')).getByText('account_switcher_account_count_one(1)')).toBeTruthy();
    expect(rowIds()).toEqual(keyrings.flatMap((keyring) => keyring.accounts.map((account) => account.address)));
    expect(screen.getByTestId('add-wallet-button').textContent).toContain('account_switcher_add_or_import_wallet');
  });

  it('marks only the current account and focuses the search field', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 2), makeKeyring(1, KeyringType.QbitHdKeyring, 2)];
    await renderSheet(keyrings, { keyring: 1, account: 1 });

    const current = screen.getAllByRole('button').filter((button) => button.getAttribute('aria-current') === 'true');
    expect(current.map((button) => button.getAttribute('data-testid'))).toEqual([
      `account-row-${keyrings[1].accounts[1].address}`
    ]);
    expect(document.activeElement).toBe(screen.getByTestId('switch-account-search'));
  });

  it('names the wallet in the accessible name of every control that acts on it', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1)];
    await renderSheet(keyrings);

    const account = keyrings[0].accounts[0];
    expect(screen.getByTestId('wallet-add-account-keyring_0').getAttribute('aria-label')).toBe(
      'account_switcher_add_account_label(Wallet 1)'
    );
    expect(screen.getByTestId('wallet-menu-keyring_0').getAttribute('aria-label')).toBe(
      'account_switcher_wallet_options_label(Wallet 1)'
    );
    expect(screen.getByTestId(`account-menu-${account.address}`).getAttribute('aria-label')).toBe(
      'account_switcher_account_options_label(Account 1|Wallet 1)'
    );
    expect(screen.getByTestId(`account-row-${account.address}`).getAttribute('aria-label')).toBe(
      `account_switcher_account_label(Account 1|Wallet 1|${shortAddress(account.address)})`
    );
    expect(screen.getByRole('dialog', { name: 'switch_account' })).toBeTruthy();
  });

  it('reads the wallets again when it opens, so the tags follow the latest recovery state', async () => {
    const stale = makeKeyring(0, KeyringType.QbitHdKeyring, 1, { qbitRecovery: recovery('seed-only-restored') });
    const fresh = { ...stale, qbitRecovery: recovery('migrated') };
    harness.reset({ keyrings: [stale], currentKeyring: stale, currentAccount: stale.accounts[0] });
    const read = deferred<WalletKeyring[]>();
    harness.wallet.getKeyrings.mockReturnValueOnce(read.promise);
    render(<AccountSwitcherSheet onClose={vi.fn()} />);
    await screen.findByTestId('switch-account-sheet');

    expect(screen.getByTestId('wallet-tag-recovered-keyring_0')).toBeTruthy();
    await act(async () => read.resolve([fresh]));

    expect(harness.wallet.getKeyrings).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('wallet-tag-recovered-keyring_0')).toBeNull();
    expect(screen.getByTestId('wallet-tag-archived-keyring_0').textContent).toBe('wallet_tag_archived');
  });
});

describe('AccountSwitcherSheet tags', () => {
  it.each([
    ['seed-only-restored', 'recovered'],
    ['migrating', 'recovered'],
    ['migrated', 'archived']
  ] as const)('tags a Qbit HD wallet in the %s state as %s', async (status, tag) => {
    await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1, { qbitRecovery: recovery(status) })]);

    expect(screen.getByTestId(`wallet-tag-${tag}-keyring_0`)).toBeTruthy();
    expect(screen.queryAllByTestId(/^wallet-tag-/)).toHaveLength(1);
  });

  it('gives a clean wallet no tag', async () => {
    await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1, { qbitRecovery: recovery('clean') })]);

    expect(screen.queryAllByTestId(/^wallet-tag-/)).toHaveLength(0);
  });

  it.each([
    [KeyringType.ReadonlyKeyring, 'read-only', 'wallet_tag_read_only'],
    [KeyringType.WatchAddressKeyring, 'read-only', 'wallet_tag_read_only'],
    [KeyringType.ColdWalletKeyring, 'cold', 'linked_to_cold_wallet']
  ])('tags a %s wallet', async (type, tag, label) => {
    await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, type, 1)]);

    expect(screen.getByTestId(`wallet-tag-${tag}-keyring_1`).textContent).toBe(label);
  });
});

describe('AccountSwitcherSheet search', () => {
  const keyrings = () => {
    const savings = makeKeyring(0, KeyringType.QbitHdKeyring, 2, { alianName: 'Savings' });
    savings.accounts[1].alianName = 'Rent';
    const travel = makeKeyring(1, KeyringType.QbitHdKeyring, 2, { alianName: 'Travel' });
    return [savings, travel];
  };
  const search = (value: string) => fireEvent.change(screen.getByTestId('switch-account-search'), { target: { value } });

  it('finds accounts by name, ignoring case and surrounding spaces', async () => {
    const list = keyrings();
    await renderSheet(list);

    search('  rENT ');

    expect(rowIds()).toEqual([list[0].accounts[1].address]);
    expect(screen.queryByTestId('wallet-group-keyring_1')).toBeNull();
  });

  it('finds an account by part of its address', async () => {
    const list = keyrings();
    await renderSheet(list);

    search('ACCOUNT1TAILADDRESS11');

    expect(rowIds()).toEqual([list[1].accounts[1].address]);
  });

  it('shows every account of a wallet whose name matches', async () => {
    const list = keyrings();
    await renderSheet(list);

    search('trav');

    expect(rowIds()).toEqual(list[1].accounts.map((account) => account.address));
  });

  it('says so when nothing matches, and lists everything again once cleared', async () => {
    await renderSheet(keyrings());

    search('nothing like this');
    expect(screen.getByTestId('switch-account-empty').textContent).toContain('account_switcher_no_results');
    expect(rowIds()).toEqual([]);

    search('');
    expect(screen.queryByTestId('switch-account-empty')).toBeNull();
    expect(rowIds()).toHaveLength(4);
  });
});

describe('AccountSwitcherSheet selection', () => {
  it('switches wallet and account in one tap and closes', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 2), makeKeyring(1, KeyringType.QbitHdKeyring, 2)];
    const target = keyrings[1].accounts[1];
    harness.wallet.getCurrentAccount.mockResolvedValue({ ...target, alianName: 'From background' });
    const { onClose } = await renderSheet(keyrings);

    fireEvent.click(screen.getByTestId(`account-row-${target.address}`));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(harness.wallet.changeKeyring).toHaveBeenCalledTimes(1);
    expect(harness.wallet.changeKeyring).toHaveBeenCalledWith(keyrings[1], 1);
    expect(harness.store.actions.map((action) => action.type)).toEqual([
      'keyrings/setKeyrings',
      'keyrings/setCurrent',
      'accounts/setCurrent'
    ]);
    expect(harness.store.state.currentKeyring).toEqual(keyrings[1]);
    expect(harness.store.state.currentAccount).toEqual({ ...target, alianName: 'From background' });
  });

  it('selects by the place of the account in its wallet, whatever index it carries', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.QbitHdKeyring, 2)];
    const target = keyrings[1].accounts[1];
    delete target.index;
    harness.wallet.getCurrentAccount.mockResolvedValue(target);
    await renderSheet(keyrings);

    fireEvent.click(screen.getByTestId(`account-row-${target.address}`));

    await waitFor(() => expect(harness.wallet.changeKeyring).toHaveBeenCalledWith(keyrings[1], 1));
  });

  it('only closes when the current account is tapped', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 2)];
    const { onClose } = await renderSheet(keyrings);

    fireEvent.click(screen.getByTestId(`account-row-${keyrings[0].accounts[0].address}`));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(harness.wallet.changeKeyring).not.toHaveBeenCalled();
  });

  it('ends two quick taps on different rows in the first one, consistently', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.QbitHdKeyring, 2)];
    const [first, second] = keyrings[1].accounts;
    const change = deferred<void>();
    harness.wallet.changeKeyring.mockReturnValueOnce(change.promise);
    harness.wallet.getCurrentAccount.mockResolvedValue(first);
    const { onClose } = await renderSheet(keyrings);

    fireEvent.click(screen.getByTestId(`account-row-${first.address}`));
    fireEvent.click(screen.getByTestId(`account-row-${second.address}`));
    fireEvent.click(screen.getByTestId(`account-row-${first.address}`));
    await act(async () => change.resolve());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(harness.wallet.changeKeyring).toHaveBeenCalledTimes(1);
    expect(harness.wallet.changeKeyring).toHaveBeenCalledWith(keyrings[1], 0);
    expect(dispatched('keyrings/setCurrent')).toHaveLength(1);
    expect(dispatched('accounts/setCurrent')).toHaveLength(1);
    expect(harness.store.state.currentKeyring.key).toBe('keyring_1');
    expect(harness.store.state.currentAccount.key).toBe(first.key);
  });

  it('shows a refused switch as a readable message and stays open', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.QbitHdKeyring, 1)];
    // Errors cross the UI port as plain objects.
    harness.wallet.changeKeyring.mockRejectedValueOnce({ message: 'Keyring is corrupted', stack: 'at …' });
    const { onClose } = await renderSheet(keyrings);

    fireEvent.click(screen.getByTestId(`account-row-${keyrings[1].accounts[0].address}`));

    await waitFor(() => expect(harness.tools.toastError).toHaveBeenCalledWith('Keyring is corrupted'));
    expect(dispatched('keyrings/setCurrent')).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('switch-account-sheet')).toBeTruthy();

    // The row can be tapped again.
    harness.wallet.getCurrentAccount.mockResolvedValue(keyrings[1].accounts[0]);
    fireEvent.click(screen.getByTestId(`account-row-${keyrings[1].accounts[0].address}`));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('reads the wallets again after a refused switch, so a wallet removed in another window leaves the list', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.QbitHdKeyring, 2)];
    const { onClose } = await renderSheet(keyrings);
    // Another window removed the second wallet after the sheet read the wallets.
    harness.wallet.getKeyrings.mockResolvedValue([keyrings[0]]);
    harness.wallet.changeKeyring.mockRejectedValueOnce({
      message: 'The selected wallet is no longer available',
      stack: 'at …'
    });

    fireEvent.click(screen.getByTestId(`account-row-${keyrings[1].accounts[1].address}`));

    // In the user's language, not the background's.
    await waitFor(() => expect(harness.tools.toastError).toHaveBeenCalledWith('account_switcher_wallet_unavailable'));
    expect(harness.tools.toastError).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('wallet-group-keyring_1')).toBeNull());
    expect(rowIds()).toEqual([keyrings[0].accounts[0].address]);
    expect(dispatched('keyrings/setCurrent')).toHaveLength(0);
    expect(dispatched('accounts/setCurrent')).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('switch-account-sheet')).toBeTruthy();
  });

  it('keeps the message of the background for a refused switch to an account gone from a wallet still there', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.QbitHdKeyring, 2)];
    await renderSheet(keyrings);
    harness.wallet.getKeyrings.mockResolvedValue([
      keyrings[0],
      { ...keyrings[1], accounts: [keyrings[1].accounts[0]] }
    ]);
    harness.wallet.changeKeyring.mockRejectedValueOnce({ message: 'The selected account is no longer available' });

    fireEvent.click(screen.getByTestId(`account-row-${keyrings[1].accounts[1].address}`));

    await waitFor(() =>
      expect(harness.tools.toastError).toHaveBeenCalledWith('The selected account is no longer available')
    );
    await waitFor(() => expect(rowIds()).toEqual([keyrings[0].accounts[0].address, keyrings[1].accounts[0].address]));
  });

  it('switches nothing when a row is tapped while a tap on the dimmed page closes the sheet', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.QbitHdKeyring, 1)];
    harness.wallet.getCurrentAccount.mockResolvedValue(keyrings[1].accounts[0]);
    const { onClose } = await renderSheet(keyrings);

    fireEvent.click(document.querySelector('.popover-container') as Element);
    // The sheet slides away for a moment, its rows still under the pointer.
    fireEvent.click(screen.getByTestId(`account-row-${keyrings[1].accounts[0].address}`));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(harness.wallet.changeKeyring).not.toHaveBeenCalled();
    expect(dispatched('keyrings/setCurrent')).toHaveLength(0);
    expect(dispatched('accounts/setCurrent')).toHaveLength(0);
  });

  it('shows the account it switched to when reading it back fails', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.QbitHdKeyring, 1)];
    harness.wallet.getCurrentAccount.mockRejectedValueOnce({ message: 'port closed' });
    const { onClose } = await renderSheet(keyrings);

    fireEvent.click(screen.getByTestId(`account-row-${keyrings[1].accounts[0].address}`));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(harness.store.state.currentKeyring.key).toBe('keyring_1');
    expect(harness.store.state.currentAccount).toEqual(keyrings[1].accounts[0]);
  });
});

describe('AccountSwitcherSheet menus', () => {
  const walletMenu = async (keyring: WalletKeyring) => {
    await renderSheet([makeKeyring(9, KeyringType.QbitHdKeyring, 1), keyring], { keyring: 0, account: 0 });
    fireEvent.click(screen.getByTestId(`wallet-menu-${keyring.key}`));
    return menuItemIds();
  };
  const accountMenu = async (keyring: WalletKeyring) => {
    await renderSheet([makeKeyring(9, KeyringType.QbitHdKeyring, 1), keyring], { keyring: 0, account: 0 });
    fireEvent.click(screen.getByTestId(`account-menu-${keyring.accounts[0].address}`));
    return menuItemIds();
  };

  it.each([
    [
      KeyringType.HdKeyring,
      ['wallet-menu-add-account', 'wallet-menu-rename', 'wallet-menu-change-color', 'wallet-menu-show-phrase', 'wallet-menu-remove']
    ],
    [
      KeyringType.QbitHdKeyring,
      ['wallet-menu-add-account', 'wallet-menu-rename', 'wallet-menu-change-color', 'wallet-menu-show-phrase', 'wallet-menu-remove']
    ],
    [KeyringType.SimpleKeyring, ['wallet-menu-rename', 'wallet-menu-change-color', 'wallet-menu-remove']],
    [KeyringType.ReadonlyKeyring, ['wallet-menu-rename', 'wallet-menu-change-color', 'wallet-menu-remove']],
    [KeyringType.WatchAddressKeyring, ['wallet-menu-rename', 'wallet-menu-change-color', 'wallet-menu-remove']],
    [KeyringType.ColdWalletKeyring, ['wallet-menu-rename', 'wallet-menu-change-color', 'wallet-menu-remove']]
  ])('offers these wallet actions for a %s wallet', async (type, expected) => {
    expect(await walletMenu(makeKeyring(1, type, 1))).toEqual(expected);
  });

  it.each([
    [KeyringType.HdKeyring, true],
    [KeyringType.QbitHdKeyring, true],
    [KeyringType.SimpleKeyring, false],
    [KeyringType.ReadonlyKeyring, false],
    [KeyringType.WatchAddressKeyring, false],
    [KeyringType.ColdWalletKeyring, false]
  ])('shows the "+" for a %s wallet: %s', async (type, shown) => {
    await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, type, 1)]);

    expect(screen.queryByTestId('wallet-add-account-keyring_1') !== null).toBe(shown);
  });

  it.each([
    [KeyringType.HdKeyring, ['account-menu-edit-name', 'account-menu-copy-address', 'account-menu-export-key']],
    [KeyringType.QbitHdKeyring, ['account-menu-edit-name', 'account-menu-copy-address']],
    [KeyringType.SimpleKeyring, ['account-menu-edit-name', 'account-menu-copy-address', 'account-menu-export-key']],
    [KeyringType.ReadonlyKeyring, ['account-menu-edit-name', 'account-menu-copy-address']],
    [KeyringType.WatchAddressKeyring, ['account-menu-edit-name', 'account-menu-copy-address']],
    [KeyringType.ColdWalletKeyring, ['account-menu-edit-name', 'account-menu-copy-address']]
  ])('offers these account actions for a %s account, never the recovery phrase', async (type, expected) => {
    const items = await accountMenu(makeKeyring(1, type, 1));

    expect(items).toEqual(expected);
    expect(screen.queryByText('show_secret_recovery_phrase')).toBeNull();
  });

  it('opens the recovery phrase and private key screens for the right wallet and account', async () => {
    const hd = makeKeyring(1, KeyringType.HdKeyring, 2);
    await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1), hd]);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_1'));
    fireEvent.click(screen.getByTestId('wallet-menu-show-phrase'));
    expect(harness.nav.navigate).toHaveBeenLastCalledWith('ExportMnemonicsScreen', { keyring: hd });

    fireEvent.click(screen.getByTestId(`account-menu-${hd.accounts[1].address}`));
    fireEvent.click(screen.getByTestId('account-menu-export-key'));
    expect(harness.nav.navigate).toHaveBeenLastCalledWith('ExportPrivateKeyScreen', { account: hd.accounts[1] });
  });

  it('copies an address with the usual feedback and closes the menu', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 2)];
    await renderSheet(keyrings);
    const trigger = screen.getByTestId(`account-menu-${keyrings[0].accounts[1].address}`);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId('account-menu-copy-address'));

    expect(harness.tools.copyToClipboard).toHaveBeenCalledWith(keyrings[0].accounts[1].address);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('moves focus into the menu, between items with the arrow keys, and back on Escape', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1)];
    const { onClose } = await renderSheet(keyrings);
    const trigger = screen.getByTestId('wallet-menu-keyring_0');

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('wallet-menu-add-account'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('wallet-menu-rename'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' });
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByTestId('wallet-menu-remove'));

    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByTestId('switch-account-sheet')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([
    ['a wallet', (keyring: WalletKeyring) => `wallet-menu-${keyring.key}`],
    ['an account', (keyring: WalletKeyring) => `account-menu-${keyring.accounts[0].address}`]
  ])('gives focus back to the search field when the wallet of %s menu is removed elsewhere', async (_menu, trigger) => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.QbitHdKeyring, 1)];
    const { onClose } = await renderSheet(keyrings);
    fireEvent.click(screen.getByTestId(trigger(keyrings[1])));
    expect(screen.getByRole('menu').contains(document.activeElement)).toBe(true);

    // The wallets read again no longer list it: another window removed it.
    act(() => {
      harness.dispatch({ type: 'keyrings/setKeyrings', payload: [keyrings[0]] });
    });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByTestId('wallet-group-keyring_1')).toBeNull();
    const search = screen.getByTestId('switch-account-search');
    expect(document.activeElement).toBe(search);
    // So Escape reaches the sheet, and Tab stays in it.
    fireEvent.keyDown(search, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('closes the menu on a tap outside it without selecting what is under it', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 2)];
    await renderSheet(keyrings);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(document.querySelector('.switcher-menu-backdrop') as Element);

    expect(screen.queryByRole('menu')).toBeNull();
    expect(harness.wallet.changeKeyring).not.toHaveBeenCalled();
  });
});

describe('AccountSwitcherSheet keyboard', () => {
  it('closes on Escape', async () => {
    const { onClose } = await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1)]);

    fireEvent.keyDown(screen.getByTestId('switch-account-search'), { key: 'Escape' });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('keeps Tab inside the sheet', async () => {
    await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1)]);
    const close = screen.getByTestId('switch-account-close');
    const addWallet = screen.getByTestId('add-wallet-button');

    addWallet.focus();
    fireEvent.keyDown(addWallet, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(addWallet);
  });

  it('opens Add or import wallet with Enter on its button', async () => {
    await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1)]);
    const addWallet = screen.getByTestId('add-wallet-button');

    expect(addWallet.getAttribute('role')).toBe('button');
    expect(addWallet.tabIndex).toBe(0);
    fireEvent.keyDown(addWallet, { key: 'Enter' });

    expect(harness.nav.navigate).toHaveBeenCalledWith('AddKeyringScreen');
  });
});

describe('AccountSwitcherSheet adding an account', () => {
  it('derives on the wallet the "+" belongs to, even when it is not current', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.QbitHdKeyring, 1)];
    await renderSheet(keyrings, { keyring: 0, account: 0 });

    fireEvent.click(screen.getByTestId('wallet-add-account-keyring_1'));

    expect(harness.nav.navigate).toHaveBeenCalledWith('CreateAccountScreen', { keyringKey: 'keyring_1' });
  });

  it('does the same from the wallet menu', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.HdKeyring, 1)];
    await renderSheet(keyrings, { keyring: 0, account: 0 });

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_1'));
    fireEvent.click(screen.getByTestId('wallet-menu-add-account'));

    expect(harness.nav.navigate).toHaveBeenCalledWith('CreateAccountScreen', { keyringKey: 'keyring_1' });
  });
});

describe('AccountSwitcherSheet corrupted wallets', () => {
  const corrupted = (type: string = KeyringType.QbitHdKeyring) =>
    makeKeyring(2, type, 0, { isCorrupted: true, alianName: 'Broken' });

  it('lists a corrupted wallet as invalid and explains it when tapped', async () => {
    await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1), corrupted()]);

    const invalid = screen.getByTestId('wallet-invalid-keyring_2');
    expect(invalid.textContent).toBe('wallet_invalid_note');
    expect(screen.queryByTestId('wallet-add-account-keyring_2')).toBeNull();
    fireEvent.click(invalid);

    expect(harness.tools.toastError).toHaveBeenCalledWith('invalid_wallet_please_remove_it_and_add_new_one');
    expect(harness.wallet.changeKeyring).not.toHaveBeenCalled();
  });

  // A wallet with a recovery phrase keeps it in the vault even when its accounts
  // cannot be listed, and the "Invalid" note asks for the wallet to be removed:
  // the phrase stays on offer so it can be backed up first.
  it.each([
    [KeyringType.HdKeyring, ['wallet-menu-rename', 'wallet-menu-show-phrase', 'wallet-menu-remove']],
    [KeyringType.QbitHdKeyring, ['wallet-menu-rename', 'wallet-menu-show-phrase', 'wallet-menu-remove']],
    [KeyringType.SimpleKeyring, ['wallet-menu-rename', 'wallet-menu-remove']],
    [KeyringType.ReadonlyKeyring, ['wallet-menu-rename', 'wallet-menu-remove']],
    [KeyringType.WatchAddressKeyring, ['wallet-menu-rename', 'wallet-menu-remove']],
    [KeyringType.ColdWalletKeyring, ['wallet-menu-rename', 'wallet-menu-remove']],
    ['Other Key Type', ['wallet-menu-rename', 'wallet-menu-remove']]
  ])('offers these wallet actions for a corrupted %s wallet', async (type, expected) => {
    await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1), corrupted(type)]);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_2'));

    expect(menuItemIds()).toEqual(expected);
  });

  it('opens the recovery phrase of the corrupted wallet itself, without switching to it', async () => {
    const broken = corrupted(KeyringType.HdKeyring);
    await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1), broken]);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_2'));
    fireEvent.click(screen.getByTestId('wallet-menu-show-phrase'));

    expect(harness.nav.navigate).toHaveBeenCalledWith('ExportMnemonicsScreen', { keyring: broken });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(harness.wallet.changeKeyring).not.toHaveBeenCalled();
  });

  it('can be found by its name', async () => {
    await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1), corrupted()]);

    fireEvent.change(screen.getByTestId('switch-account-search'), { target: { value: 'brok' } });

    expect(screen.getByTestId('wallet-invalid-keyring_2')).toBeTruthy();
    expect(rowIds()).toEqual([]);
  });
});

describe('AccountSwitcherSheet removing a wallet', () => {
  it('refuses to remove the last wallet', async () => {
    await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1)]);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));

    expect(harness.tools.toastError).toHaveBeenCalledWith('removing_the_last_wallet_is_not_allowed');
    expect(screen.queryByText('please_pay_attention_to_whether_you_have_backed_up')).toBeNull();
    expect(harness.wallet.removeKeyring).not.toHaveBeenCalled();
  });

  // As in the background, a usable wallet must stay: a corrupted one cannot be
  // opened, so it does not count.
  it('refuses to remove the only usable wallet beside a corrupted one, but not the corrupted one', async () => {
    const broken = makeKeyring(2, KeyringType.QbitHdKeyring, 0, { isCorrupted: true, alianName: 'Broken' });
    await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1), broken]);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));
    expect(harness.tools.toastError).toHaveBeenCalledWith('removing_the_last_wallet_is_not_allowed');
    expect(screen.queryByText('please_pay_attention_to_whether_you_have_backed_up')).toBeNull();

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_2'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));
    expect(screen.getByText('please_pay_attention_to_whether_you_have_backed_up')).toBeTruthy();
    expect(harness.tools.toastError).toHaveBeenCalledTimes(1);
    expect(harness.wallet.removeKeyring).not.toHaveBeenCalled();
  });

  it('refuses every removal when no wallet is usable', async () => {
    await renderSheet([
      makeKeyring(0, KeyringType.HdKeyring, 0, { isCorrupted: true }),
      makeKeyring(1, KeyringType.QbitHdKeyring, 0, { isCorrupted: true })
    ]);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_1'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));

    expect(harness.tools.toastError).toHaveBeenCalledWith('removing_the_last_wallet_is_not_allowed');
    expect(screen.queryByText('please_pay_attention_to_whether_you_have_backed_up')).toBeNull();
  });

  it('confirms in the removal popover, then drops the wallet from the open sheet', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.QbitHdKeyring, 1)];
    await renderSheet(keyrings, { keyring: 1, account: 0 });
    // The current wallet goes: the background switches to the other one.
    harness.wallet.removeKeyring.mockResolvedValue(keyrings[0]);
    harness.wallet.getKeyrings.mockResolvedValue([keyrings[0]]);
    harness.wallet.getCurrentAccount.mockResolvedValue(keyrings[0].accounts[0]);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_1'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));
    expect(screen.getByText('please_pay_attention_to_whether_you_have_backed_up')).toBeTruthy();
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(screen.queryByTestId('wallet-group-keyring_1')).toBeNull());
    expect(harness.wallet.removeKeyring).toHaveBeenCalledWith(keyrings[1], undefined);
    expect(screen.queryByText('please_pay_attention_to_whether_you_have_backed_up')).toBeNull();
    expect(harness.store.state.currentAccount).toEqual(keyrings[0].accounts[0]);
    expect(screen.getByTestId(`account-row-${keyrings[0].accounts[0].address}`).getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('switch-account-search'));
  });

  // A read that started before the removal can settle after it and still list
  // the removed wallet.
  it('closes the removal popover once the wallet is removed, though the wallets read still list it', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.QbitHdKeyring, 1)];
    await renderSheet(keyrings, { keyring: 1, account: 0 });
    harness.wallet.removeKeyring.mockResolvedValue(keyrings[0]);
    harness.wallet.getKeyrings.mockResolvedValue(keyrings);
    harness.wallet.getCurrentAccount.mockResolvedValue(keyrings[0].accounts[0]);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_1'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(screen.queryByText('please_pay_attention_to_whether_you_have_backed_up')).toBeNull());
    expect(harness.wallet.removeKeyring).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('wallet-group-keyring_1')).toBeNull();
    expect(harness.store.state.currentAccount).toEqual(keyrings[0].accounts[0]);
    expect(document.activeElement).toBe(screen.getByTestId('switch-account-search'));
  });

  it('removes another wallet and keeps the current wallet and account', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 2), makeKeyring(1, KeyringType.QbitHdKeyring, 1)];
    await renderSheet(keyrings, { keyring: 0, account: 1 });
    const current = keyrings[0].accounts[1];
    harness.wallet.removeKeyring.mockResolvedValue(keyrings[0]);
    harness.wallet.getKeyrings.mockResolvedValue([keyrings[0]]);
    harness.wallet.getCurrentAccount.mockResolvedValue(current);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_1'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(screen.queryByTestId('wallet-group-keyring_1')).toBeNull());
    await waitFor(() => expect(dispatched('accounts/setCurrent')).toHaveLength(1));
    expect(harness.store.state.currentKeyring).toEqual(keyrings[0]);
    expect(harness.store.state.currentAccount).toEqual(current);
    expect(screen.getByTestId(`account-row-${current.address}`).getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId(`account-row-${keyrings[0].accounts[0].address}`).getAttribute('aria-current')).toBeNull();
  });

  it('cancels the removal popover with Escape and keeps the sheet open', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.QbitHdKeyring, 1)];
    const { onClose } = await renderSheet(keyrings);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_1'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));
    const popover = screen.getByRole('dialog', { name: 'remove_wallet' });
    expect(popover.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(popover, { key: 'Escape' });

    expect(screen.queryByText('please_pay_attention_to_whether_you_have_backed_up')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('wallet-menu-keyring_1'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(onClose).not.toHaveBeenCalled();
    expect(harness.wallet.removeKeyring).not.toHaveBeenCalled();
  });
});

describe('AccountSwitcherSheet renaming and colors', () => {
  it('renames a wallet in place, trimming the name', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1)];
    await renderSheet(keyrings);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(screen.getByTestId('wallet-menu-rename'));
    const input = screen.getByTestId('name-edit-input') as HTMLInputElement;
    expect(input.value).toBe('Wallet 1');
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '  Travel  ' } });
    fireEvent.click(screen.getByTestId('name-edit-save'));

    await waitFor(() => expect(screen.getByTestId('wallet-name-keyring_0').textContent).toBe('Travel'));
    expect(harness.wallet.setKeyringAlianName).toHaveBeenCalledWith(keyrings[0], 'Travel');
    expect(harness.store.state.currentKeyring.alianName).toBe('Travel');
    expect(screen.queryByTestId('name-edit-dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('wallet-menu-keyring_0'));
  });

  it('will not save an empty name', async () => {
    await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1)]);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(screen.getByTestId('wallet-menu-rename'));
    fireEvent.change(screen.getByTestId('name-edit-input'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('name-edit-save'));

    expect(harness.wallet.setKeyringAlianName).not.toHaveBeenCalled();
    expect(screen.getByTestId('name-edit-dialog')).toBeTruthy();
  });

  it('renames an account, and keeps the dialog open with the error when the background refuses', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 2)];
    const account = keyrings[0].accounts[0];
    harness.wallet.setAccountAlianName.mockRejectedValueOnce({ message: 'storage is locked' });
    await renderSheet(keyrings);

    fireEvent.click(screen.getByTestId(`account-menu-${account.address}`));
    fireEvent.click(screen.getByTestId('account-menu-edit-name'));
    fireEvent.change(screen.getByTestId('name-edit-input'), { target: { value: 'Rent' } });
    fireEvent.submit(screen.getByTestId('name-edit-input').closest('form') as HTMLFormElement);

    await waitFor(() => expect(harness.tools.toastError).toHaveBeenCalledWith('storage is locked'));
    expect(screen.getByTestId('name-edit-dialog')).toBeTruthy();

    fireEvent.click(screen.getByTestId('name-edit-save'));
    await waitFor(() => expect(screen.queryByTestId('name-edit-dialog')).toBeNull());
    expect(harness.wallet.setAccountAlianName).toHaveBeenLastCalledWith(account, 'Rent');
    expect(screen.getByTestId(`account-row-${account.address}`).textContent).toContain('Rent');
    expect(harness.store.state.currentAccount.alianName).toBe('Rent');
  });

  it('leaves another dialog open when a save settles after its own dialog was dismissed', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.QbitHdKeyring, 1)];
    await renderSheet(keyrings);
    const rename = deferred<WalletKeyring>();
    harness.wallet.setKeyringAlianName.mockReturnValueOnce(rename.promise);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(screen.getByTestId('wallet-menu-rename'));
    fireEvent.change(screen.getByTestId('name-edit-input'), { target: { value: 'Travel' } });
    fireEvent.click(screen.getByTestId('name-edit-save'));
    // Dismissed while the background is still saving.
    fireEvent.keyDown(screen.getByTestId('name-edit-dialog'), { key: 'Escape' });
    expect(screen.queryByTestId('name-edit-dialog')).toBeNull();

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_1'));
    fireEvent.click(screen.getByTestId('wallet-menu-change-color'));
    const focused = document.activeElement;
    expect(focused).toBe(screen.getByTestId('wallet-color-swatch-blue'));
    await act(async () => rename.resolve({ ...keyrings[0], alianName: 'Travel' }));

    // The name is saved, and the picker opened since keeps its place and focus.
    expect(screen.getByTestId('wallet-name-keyring_0').textContent).toBe('Travel');
    expect(screen.getByTestId('wallet-color-picker')).toBeTruthy();
    expect(document.activeElement).toBe(focused);
  });

  it('does not take the focus back when a save settles after its dialog was dismissed', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.QbitHdKeyring, 1)];
    await renderSheet(keyrings);
    const recolor = deferred<WalletKeyring>();
    harness.wallet.setKeyringColor.mockReturnValueOnce(recolor.promise);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(screen.getByTestId('wallet-menu-change-color'));
    fireEvent.click(screen.getByTestId('wallet-color-swatch-pink'));
    fireEvent.click(screen.getByTestId('wallet-color-cancel'));
    expect(screen.queryByTestId('wallet-color-picker')).toBeNull();

    // A menu opened since keeps the focus.
    fireEvent.click(screen.getByTestId('wallet-menu-keyring_1'));
    const focused = document.activeElement;
    expect(focused).toBe(screen.getByTestId('wallet-menu-add-account'));
    await act(async () => recolor.resolve({ ...keyrings[0], color: 'pink' }));

    expect(screen.getByTestId('wallet-tile-keyring_0').getAttribute('data-color')).toBe('pink');
    expect(document.activeElement).toBe(focused);
  });

  it('marks the current color, saves the picked one and recolors the tile', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.QbitHdKeyring, 1)];
    await renderSheet(keyrings, { keyring: 1, account: 0 });

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_1'));
    fireEvent.click(screen.getByTestId('wallet-menu-change-color'));
    const picker = screen.getByTestId('wallet-color-picker');
    const pressed = within(picker)
      .getAllByRole('button', { pressed: true })
      .map((button) => button.getAttribute('data-testid'));
    expect(pressed).toEqual(['wallet-color-swatch-blue']);
    expect(within(picker).getAllByTestId(/^wallet-color-swatch-/)).toHaveLength(WALLET_COLOR_KEYS.length);
    expect(screen.getByTestId('wallet-color-swatch-pink').getAttribute('aria-label')).toBe('wallet_color_pink');
    expect(document.activeElement).toBe(screen.getByTestId('wallet-color-swatch-blue'));

    fireEvent.click(screen.getByTestId('wallet-color-swatch-pink'));

    await waitFor(() => expect(screen.queryByTestId('wallet-color-picker')).toBeNull());
    expect(harness.wallet.setKeyringColor).toHaveBeenCalledWith(keyrings[1], 'pink');
    expect(screen.getByTestId('wallet-tile-keyring_1').getAttribute('data-color')).toBe('pink');
    expect(harness.store.state.currentKeyring.color).toBe('pink');
  });

  it('only closes when the current color is tapped, and reports a refused color', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1)];
    harness.wallet.setKeyringColor.mockRejectedValueOnce({ message: 'The selected wallet is no longer available' });
    await renderSheet(keyrings);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(screen.getByTestId('wallet-menu-change-color'));
    fireEvent.click(screen.getByTestId('wallet-color-swatch-teal'));
    await waitFor(() =>
      expect(harness.tools.toastError).toHaveBeenCalledWith('The selected wallet is no longer available')
    );
    expect(screen.getByTestId('wallet-tile-keyring_0').getAttribute('data-color')).toBe('green');

    fireEvent.click(screen.getByTestId('wallet-color-swatch-green'));
    expect(screen.queryByTestId('wallet-color-picker')).toBeNull();
    expect(harness.wallet.setKeyringColor).toHaveBeenCalledTimes(1);
  });

  // The background refuses a wallet another window removed after the sheet
  // read the wallets; its message is English.
  const removedElsewhere = { message: 'The selected wallet is no longer available', stack: 'at …' };

  it.each([
    [
      'rename',
      () => {
        harness.wallet.setKeyringAlianName.mockRejectedValueOnce(removedElsewhere);
        fireEvent.click(screen.getByTestId('wallet-menu-rename'));
        fireEvent.change(screen.getByTestId('name-edit-input'), { target: { value: 'Travel' } });
        fireEvent.click(screen.getByTestId('name-edit-save'));
      },
      'name-edit-dialog'
    ],
    [
      'color change',
      () => {
        harness.wallet.setKeyringColor.mockRejectedValueOnce(removedElsewhere);
        fireEvent.click(screen.getByTestId('wallet-menu-change-color'));
        fireEvent.click(screen.getByTestId('wallet-color-swatch-pink'));
      },
      'wallet-color-picker'
    ]
  ])(
    'says in the user language that the wallet is gone when its %s is refused, and drops it from the list',
    async (_change, change, dialogTestId) => {
      const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.QbitHdKeyring, 1)];
      await renderSheet(keyrings);
      harness.wallet.getKeyrings.mockResolvedValue([keyrings[0]]);

      fireEvent.click(screen.getByTestId('wallet-menu-keyring_1'));
      change();

      await waitFor(() => expect(harness.tools.toastError).toHaveBeenCalledWith('account_switcher_wallet_unavailable'));
      expect(harness.tools.toastError).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.queryByTestId('wallet-group-keyring_1')).toBeNull());
      expect(screen.queryByTestId(dialogTestId)).toBeNull();
      expect(document.activeElement).toBe(screen.getByTestId('switch-account-search'));
      expect(harness.store.state.keyrings).toEqual([keyrings[0]]);
    }
  );

  it('keeps the message of the background, and the dialog, for a refused rename of a wallet still there', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.QbitHdKeyring, 1)];
    await renderSheet(keyrings);
    harness.wallet.setKeyringAlianName.mockRejectedValueOnce({ message: 'storage is locked' });

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_1'));
    fireEvent.click(screen.getByTestId('wallet-menu-rename'));
    fireEvent.change(screen.getByTestId('name-edit-input'), { target: { value: 'Travel' } });
    fireEvent.click(screen.getByTestId('name-edit-save'));

    await waitFor(() => expect(harness.tools.toastError).toHaveBeenCalledWith('storage is locked'));
    expect(screen.getByTestId('name-edit-dialog')).toBeTruthy();
    expect(screen.getByTestId('wallet-group-keyring_1')).toBeTruthy();
  });
});

describe('AccountSwitcherSheet stale reads', () => {
  it('drops a wallets read that settles after the sheet closed', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1)];
    harness.reset({ keyrings, currentKeyring: keyrings[0], currentAccount: keyrings[0].accounts[0] });
    const read = deferred<WalletKeyring[]>();
    harness.wallet.getKeyrings.mockReturnValueOnce(read.promise);
    const { unmount } = render(<AccountSwitcherSheet onClose={vi.fn()} />);
    await screen.findByTestId('switch-account-sheet');

    unmount();
    await act(async () => read.resolve([{ ...keyrings[0], alianName: 'Old name' }]));

    expect(dispatched('keyrings/setKeyrings')).toHaveLength(0);
    expect(harness.store.state.keyrings).toBe(keyrings);
  });

  it('drops a wallets read that settles after a tap on the dimmed page began closing the sheet', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1)];
    harness.reset({ keyrings, currentKeyring: keyrings[0], currentAccount: keyrings[0].accounts[0] });
    const read = deferred<WalletKeyring[]>();
    harness.wallet.getKeyrings.mockReturnValueOnce(read.promise);
    render(<AccountSwitcherSheet onClose={vi.fn()} />);
    await screen.findByTestId('switch-account-sheet');

    fireEvent.click(document.querySelector('.popover-container') as Element);
    await act(async () => read.resolve([{ ...keyrings[0], alianName: 'Old name' }]));

    expect(dispatched('keyrings/setKeyrings')).toHaveLength(0);
    expect(harness.store.state.keyrings).toBe(keyrings);
  });

  it('drops a wallets read that a rename overtook', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1)];
    harness.reset({ keyrings, currentKeyring: keyrings[0], currentAccount: keyrings[0].accounts[0] });
    const first = deferred<WalletKeyring[]>();
    harness.wallet.getKeyrings
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([{ ...keyrings[0], alianName: 'Travel' }]);
    render(<AccountSwitcherSheet onClose={vi.fn()} />);
    await screen.findByTestId('switch-account-sheet');

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(screen.getByTestId('wallet-menu-rename'));
    fireEvent.change(screen.getByTestId('name-edit-input'), { target: { value: 'Travel' } });
    fireEvent.click(screen.getByTestId('name-edit-save'));
    await waitFor(() => expect(screen.getByTestId('wallet-name-keyring_0').textContent).toBe('Travel'));

    // The read made on opening settles last, with the name from before.
    await act(async () => first.resolve(keyrings));

    expect(screen.getByTestId('wallet-name-keyring_0').textContent).toBe('Travel');
    expect(harness.store.state.keyrings[0].alianName).toBe('Travel');
    expect(harness.wallet.getKeyrings).toHaveBeenCalledTimes(2);
  });

  it('drops an older read that settles after a newer one', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1)];
    harness.reset({ keyrings, currentKeyring: keyrings[0], currentAccount: keyrings[0].accounts[0] });
    const first = deferred<WalletKeyring[]>();
    harness.wallet.getKeyrings
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([{ ...keyrings[0], color: 'gold' }]);
    render(<AccountSwitcherSheet onClose={vi.fn()} />);
    await screen.findByTestId('switch-account-sheet');

    // A color change reads the wallets again; that newer read settles first.
    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(screen.getByTestId('wallet-menu-change-color'));
    fireEvent.click(screen.getByTestId('wallet-color-swatch-gold'));
    await waitFor(() => expect(screen.getByTestId('wallet-tile-keyring_0').getAttribute('data-color')).toBe('gold'));
    await act(async () => first.resolve(keyrings));

    expect(screen.getByTestId('wallet-tile-keyring_0').getAttribute('data-color')).toBe('gold');
  });
});
