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
    nav: {} as Record<string, ReturnType<typeof vi.fn>>,
    // useReloadAccounts: the wallets and the selection, read back.
    reloadAccounts: vi.fn()
  };
});

vi.mock('@qbit/wallet-state', async () => {
  const React = await import('react');
  // The package's own rule for an Enter pressed in a field. The package index
  // needs import paths only the package's own setup resolves, so the module
  // that holds the rule is imported alone.
  const { isEnterPressedInField } = await import(
    '../../../../../../packages/wallet-state/src/ui-hooks/isEnterPressedInField'
  );
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
    isEnterPressedInField,
    useAppDispatch: () => harness.dispatch,
    useCurrentAccount: () => useSelect((state) => state.currentAccount),
    useCurrentKeyring: () => useSelect((state) => state.currentKeyring),
    useKeyrings: () => useSelect((state) => state.keyrings),
    useI18n: () => ({ t: harness.t, locale: 'en' }),
    useNavigation: () => harness.nav,
    // As the hook does: the page-side call the reset dialog makes.
    useResetWallet: () => (password: string, options?: unknown) => harness.wallet.resetWallet(password, options),
    useReloadAccounts: () => harness.reloadAccounts,
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
// A tap on the dimmed page above the sheet, which closes it: the sheet slides
// away for a moment, still under the pointer.
const tapDimmedPage = () => fireEvent.click(document.querySelector('.popover-container') as Element);

beforeEach(() => {
  harness.wallet = {
    getKeyrings: vi.fn(async () => harness.store.state.keyrings),
    changeKeyring: vi.fn(async () => undefined),
    getCurrentAccount: vi.fn(),
    setKeyringAlianName: vi.fn(async (keyring: WalletKeyring, name: string) => ({ ...keyring, alianName: name })),
    setAccountAlianName: vi.fn(async (account: Account, name: string) => ({ ...account, alianName: name })),
    setKeyringColor: vi.fn(async (keyring: WalletKeyring, color: string) => ({ ...keyring, color })),
    removeKeyring: vi.fn(),
    resetWallet: vi.fn(),
    isBooted: vi.fn(async () => true),
    isUnlocked: vi.fn(async () => true),
    getNextAlianName: vi.fn(async (keyring: WalletKeyring) => `Account ${keyring.accounts.length + 1}`),
    deriveNewAccountFromMnemonic: vi.fn(async () => ({ floorScanPending: false }))
  };
  harness.tools = { toastError: vi.fn(), toastSuccess: vi.fn(), toastWarning: vi.fn(), copyToClipboard: vi.fn() };
  harness.nav = { navigate: vi.fn() };
  harness.reloadAccounts = vi.fn(async () => undefined);
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

    tapDimmedPage();
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

describe('AccountSwitcherSheet while it is leaving', () => {
  // A wallet with a recovery phrase and two accounts, beside a corrupted one:
  // its menu offers every wallet action, its accounts export their keys, and
  // it is the last wallet that can be opened, so removing it is refused.
  const fixture = () => [
    makeKeyring(0, KeyringType.HdKeyring, 2),
    makeKeyring(1, KeyringType.QbitHdKeyring, 0, { isCorrupted: true, alianName: 'Broken' })
  ];
  const walletMenu = (keyrings: WalletKeyring[]) => `wallet-menu-${keyrings[0].key}`;
  const accountMenu = (keyrings: WalletKeyring[]) => `account-menu-${keyrings[0].accounts[0].address}`;
  const dialogsOnScreen = () => screen.queryAllByRole('dialog').map((dialog) => dialog.getAttribute('data-testid'));

  /**
   * Starts the sheet leaving and returns what checks the end of it: a switch
   * under way closes the sheet once it settles, with the account selected; a
   * tap on the dimmed page has closed it already.
   */
  const leave = (state: 'switching' | 'closing', keyrings: WalletKeyring[]) => {
    if (state === 'closing') {
      tapDimmedPage();
      return async () => undefined;
    }
    const target = keyrings[0].accounts[1];
    const change = deferred<void>();
    harness.wallet.changeKeyring.mockReturnValueOnce(change.promise);
    harness.wallet.getCurrentAccount.mockResolvedValue(target);
    fireEvent.click(screen.getByTestId(`account-row-${target.address}`));
    return async (onClose: ReturnType<typeof vi.fn>) => {
      await act(async () => change.resolve());
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(harness.store.state.currentAccount).toEqual(target);
    };
  };

  // Every opener and action of the sheet, with the menu it is in, if any.
  const actions: [string, ((keyrings: WalletKeyring[]) => string) | null, (keyrings: WalletKeyring[]) => void][] = [
    ['"+"', null, (keyrings) => fireEvent.click(screen.getByTestId(`wallet-add-account-${keyrings[0].key}`))],
    ['Add or import wallet', null, () => fireEvent.click(screen.getByTestId('add-wallet-button'))],
    [
      'Enter on Add or import wallet',
      null,
      () => fireEvent.keyDown(screen.getByTestId('add-wallet-button'), { key: 'Enter' })
    ],
    ['the Invalid note', null, (keyrings) => fireEvent.click(screen.getByTestId(`wallet-invalid-${keyrings[1].key}`))],
    ['Add Account', walletMenu, () => fireEvent.click(screen.getByTestId('wallet-menu-add-account'))],
    ['Rename Wallet', walletMenu, () => fireEvent.click(screen.getByTestId('wallet-menu-rename'))],
    ['Change Color', walletMenu, () => fireEvent.click(screen.getByTestId('wallet-menu-change-color'))],
    ['Backup/Show Seed Phrase', walletMenu, () => fireEvent.click(screen.getByTestId('wallet-menu-show-phrase'))],
    ['Remove Wallet', walletMenu, () => fireEvent.click(screen.getByTestId('wallet-menu-remove'))],
    ['Edit Name', accountMenu, () => fireEvent.click(screen.getByTestId('account-menu-edit-name'))],
    ['Copy Address', accountMenu, () => fireEvent.click(screen.getByTestId('account-menu-copy-address'))],
    ['Export Private Key', accountMenu, () => fireEvent.click(screen.getByTestId('account-menu-export-key'))]
  ];

  describe.each([
    ['while a switch is under way', 'switching'],
    ['while a tap on the dimmed page closes the sheet', 'closing']
  ] as const)('%s', (_state, state) => {
    it('opens no wallet or account menu', async () => {
      const keyrings = fixture();
      const { onClose } = await renderSheet(keyrings);
      const ended = leave(state, keyrings);

      fireEvent.click(screen.getByTestId(walletMenu(keyrings)));
      expect(screen.queryByRole('menu')).toBeNull();
      fireEvent.click(screen.getByTestId(accountMenu(keyrings)));
      expect(screen.queryByRole('menu')).toBeNull();
      expect(screen.getByTestId(walletMenu(keyrings)).getAttribute('aria-expanded')).toBe('false');

      await ended(onClose);
    });

    it.each(actions)('%s does nothing, and closes the menu it is in', async (_action, menu, perform) => {
      const keyrings = fixture();
      const { onClose } = await renderSheet(keyrings);
      // A menu opened before, still on the sheet: a row tapped with it open,
      // as no pointer can, or the sheet sliding away with it.
      if (menu) {
        fireEvent.click(screen.getByTestId(menu(keyrings)));
        expect(screen.getByRole('menu')).toBeTruthy();
      }
      const ended = leave(state, keyrings);

      perform(keyrings);

      expect(screen.queryByRole('menu')).toBeNull();
      expect(dialogsOnScreen()).toEqual(['switch-account-sheet']);
      expect(harness.nav.navigate).not.toHaveBeenCalled();
      expect(harness.tools.toastError).not.toHaveBeenCalled();
      expect(harness.tools.copyToClipboard).not.toHaveBeenCalled();
      expect(harness.wallet.getNextAlianName).not.toHaveBeenCalled();
      await ended(onClose);
    });
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
    expect(screen.queryByText('wallet_menu_backup_seed_phrase')).toBeNull();
  });

  it('labels the recovery phrase item of a wallet menu Backup/Show Seed Phrase', async () => {
    expect(await walletMenu(makeKeyring(1, KeyringType.QbitHdKeyring, 1))).toContain('wallet-menu-show-phrase');

    expect(screen.getByTestId('wallet-menu-show-phrase').textContent).toBe('wallet_menu_backup_seed_phrase');
    expect(screen.queryByText('show_secret_recovery_phrase')).toBeNull();
  });

  it('puts "+" and the menu button of a wallet side by side, the menu button last', async () => {
    await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.SimpleKeyring, 1)]);

    const actions = (keyringKey: string) =>
      Array.from(screen.getByTestId(`wallet-menu-${keyringKey}`).parentElement?.children ?? []).map((button) =>
        button.getAttribute('data-testid')
      );
    expect(actions('keyring_0')).toEqual(['wallet-add-account-keyring_0', 'wallet-menu-keyring_0']);
    // A wallet without "+" keeps its menu button where it is.
    expect(actions('keyring_1')).toEqual(['wallet-menu-keyring_1']);
    expect(screen.getByTestId('wallet-menu-keyring_1').parentElement?.className).toBe('switcher-group__actions');
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

  it('closes the menu on Tab, focus back on its button, before the sheet keeps Tab inside', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1)];
    await renderSheet(keyrings);
    const trigger = screen.getByTestId(`wallet-menu-${keyrings[0].key}`);
    fireEvent.click(trigger);
    // The menu's items, out of the tab order, have focus.
    const item = document.activeElement as HTMLElement;
    expect(item.getAttribute('role')).toBe('menuitem');
    expect(item.tabIndex).toBe(-1);

    fireEvent.keyDown(item, { key: 'Tab' });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
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
  const twoWallets = () => [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.QbitHdKeyring, 1)];
  const newAccountDialog = () => screen.queryByTestId('new-account-dialog');
  const nameField = () => screen.getByTestId('create-account-name-input') as HTMLInputElement;
  const createButton = () => screen.getByTestId('create-account-confirm-button');
  const waitPastCloseAnimation = () => new Promise((resolve) => setTimeout(resolve, 350));

  /** "+" on a wallet's group, focused first as a click focuses it in the browser. */
  const openFromPlus = async (keyringKey: string) => {
    const plus = screen.getByTestId(`wallet-add-account-${keyringKey}`);
    plus.focus();
    fireEvent.click(plus);
    // Let the suggested name arrive.
    await act(async () => {
      await Promise.resolve();
    });
    return plus;
  };

  it('opens the New account dialog over the open sheet for the wallet of the "+", even when it is not current', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.QbitHdKeyring, 2)];
    await renderSheet(keyrings, { keyring: 0, account: 0 });

    await openFromPlus('keyring_1');

    expect(screen.getByRole('dialog', { name: 'new_account' })).toBe(newAccountDialog());
    expect(screen.getByTestId('switch-account-sheet')).toBeTruthy();
    expect(harness.nav.navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId('create-account-wallet-name').textContent).toBe('Wallet 2');
    expect(screen.getByTestId('create-account-wallet-tile').getAttribute('data-color')).toBe(keyrings[1].color);
    expect(harness.wallet.getNextAlianName).toHaveBeenCalledWith(keyrings[1]);
    expect(nameField().placeholder).toBe('Account 3');
    expect(document.activeElement).toBe(nameField());
  });

  it('reads the suggested name again when the wallets read on opening land with another account', async () => {
    const keyrings = twoWallets();
    harness.reset({ keyrings, currentKeyring: keyrings[0], currentAccount: keyrings[0].accounts[0] });
    const openingRead = deferred<WalletKeyring[]>();
    harness.wallet.getKeyrings.mockReturnValueOnce(openingRead.promise);
    render(<AccountSwitcherSheet onClose={vi.fn()} />);
    await screen.findByTestId('switch-account-sheet');
    await openFromPlus(keyrings[1].key);
    expect(nameField().placeholder).toBe('Account 2');

    // Another window added an account to that wallet before the sheet opened.
    const grown = makeKeyring(1, KeyringType.QbitHdKeyring, 2);
    await act(async () => openingRead.resolve([keyrings[0], grown]));

    expect(harness.wallet.getNextAlianName).toHaveBeenLastCalledWith(grown);
    expect(nameField().placeholder).toBe('Account 3');
  });

  it('opens it from Add Account in the wallet menu, closing the menu', async () => {
    await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.HdKeyring, 1)]);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_1'));
    fireEvent.click(screen.getByTestId('wallet-menu-add-account'));

    expect(screen.queryByRole('menu')).toBeNull();
    expect(newAccountDialog()).not.toBeNull();
    expect(screen.getByTestId('create-account-wallet-name').textContent).toBe('Wallet 2');
    expect(harness.nav.navigate).not.toHaveBeenCalled();
  });

  it.each([
    ['Cancel', () => fireEvent.click(screen.getByTestId('create-account-cancel-button'))],
    ['Escape', () => fireEvent.keyDown(screen.getByTestId('create-account-name-input'), { key: 'Escape' })],
    ['the close button', () => fireEvent.click(screen.getByTestId('create-account-close-button'))]
  ])('returns to the open sheet, focus on the "+", with %s before Create', async (_way, dismiss) => {
    const { onClose } = await renderSheet(twoWallets());
    const plus = await openFromPlus('keyring_1');

    dismiss();

    expect(newAccountDialog()).toBeNull();
    expect(document.activeElement).toBe(plus);
    expect(screen.getByTestId('switch-account-sheet')).toBeTruthy();
    await waitPastCloseAnimation();
    expect(onClose).not.toHaveBeenCalled();
    expect(harness.wallet.deriveNewAccountFromMnemonic).not.toHaveBeenCalled();
  });

  it('gives focus back to the wallet menu button when the dialog came from the menu', async () => {
    await renderSheet(twoWallets());
    const trigger = screen.getByTestId('wallet-menu-keyring_1');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId('wallet-menu-add-account'));

    fireEvent.keyDown(nameField(), { key: 'Escape' });

    expect(newAccountDialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('creates the account on the wallet of the "+" with the typed name, says so, and closes the dialog and the sheet', async () => {
    const keyrings = twoWallets();
    const { onClose } = await renderSheet(keyrings, { keyring: 0, account: 0 });
    const plus = await openFromPlus('keyring_1');

    fireEvent.change(nameField(), { target: { value: 'Savings' } });
    fireEvent.click(createButton());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(harness.wallet.deriveNewAccountFromMnemonic).toHaveBeenCalledTimes(1);
    expect(harness.wallet.deriveNewAccountFromMnemonic).toHaveBeenCalledWith(keyrings[1], 'Savings');
    expect(harness.tools.toastSuccess).toHaveBeenCalledWith('account_created');
    expect(harness.tools.toastWarning).not.toHaveBeenCalled();
    expect(harness.tools.toastError).not.toHaveBeenCalled();
    // The background selected the new account; the store reads it back.
    expect(harness.reloadAccounts).toHaveBeenCalledTimes(1);
    expect(newAccountDialog()).toBeNull();
    expect(document.activeElement).toBe(plus);
    // The sheet is closing: "+" opens nothing more.
    fireEvent.click(plus);
    expect(newAccountDialog()).toBeNull();
  });

  it('sends no name when none is typed, so the background names the account as it derives it', async () => {
    const keyrings = twoWallets();
    const { onClose } = await renderSheet(keyrings);
    await openFromPlus('keyring_1');
    expect(nameField().placeholder).toBe('Account 2');

    fireEvent.click(createButton());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(harness.wallet.deriveNewAccountFromMnemonic.mock.calls).toEqual([[keyrings[1]]]);
  });

  it('derives on the wallet as the store lists it when Create is pressed', async () => {
    const keyrings = twoWallets();
    await renderSheet(keyrings);
    await openFromPlus('keyring_1');
    // Renamed in another window while the dialog is open, and read again.
    const renamed = { ...keyrings[1], alianName: 'Travel' };
    act(() => {
      harness.dispatch({ type: 'keyrings/setKeyrings', payload: [keyrings[0], renamed] });
    });
    expect(screen.getByTestId('create-account-wallet-name').textContent).toBe('Travel');

    fireEvent.click(createButton());

    await waitFor(() => expect(harness.wallet.deriveNewAccountFromMnemonic).toHaveBeenCalledTimes(1));
    expect(harness.wallet.deriveNewAccountFromMnemonic.mock.calls).toEqual([[renamed]]);
  });

  it('derives one account however often Create or Enter is pressed, and nothing dismisses it meanwhile', async () => {
    const derive = deferred<{ floorScanPending: boolean }>();
    harness.wallet.deriveNewAccountFromMnemonic.mockReturnValueOnce(derive.promise);
    const { onClose } = await renderSheet(twoWallets());
    const plus = await openFromPlus('keyring_1');

    fireEvent.click(createButton());
    fireEvent.click(createButton());
    fireEvent.keyDown(nameField(), { key: 'Enter' });
    fireEvent.keyDown(nameField(), { key: 'Enter', repeat: true });
    fireEvent.click(screen.getByTestId('create-account-cancel-button'));
    fireEvent.click(screen.getByTestId('create-account-close-button'));
    fireEvent.keyDown(nameField(), { key: 'Escape' });
    // Under the dialog: no second dialog, so no second derive.
    fireEvent.click(plus);

    expect(harness.wallet.deriveNewAccountFromMnemonic).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId('new-account-dialog')).toHaveLength(1);
    expect(newAccountDialog()?.getAttribute('aria-busy')).toBe('true');
    expect(createButton().getAttribute('aria-disabled')).toBe('true');
    expect(nameField().readOnly).toBe(true);
    await waitPastCloseAnimation();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => derive.resolve({ floorScanPending: false }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(harness.wallet.deriveNewAccountFromMnemonic).toHaveBeenCalledTimes(1);
  });

  it('creates nothing on the Enter that opened the dialog from "+", only on an Enter pressed in its field', async () => {
    await renderSheet(twoWallets());
    const plus = screen.getByTestId('wallet-add-account-keyring_1');
    plus.focus();

    // A button acts on the keydown of an Enter. The key comes up, or repeats
    // while it is held, in the field that took focus meanwhile.
    fireEvent.keyDown(plus, { key: 'Enter' });
    fireEvent.click(plus);
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(nameField());
    fireEvent.keyDown(nameField(), { key: 'Enter', repeat: true });
    fireEvent.keyUp(nameField(), { key: 'Enter' });
    expect(harness.wallet.deriveNewAccountFromMnemonic).not.toHaveBeenCalled();

    fireEvent.keyDown(nameField(), { key: 'Enter' });
    await waitFor(() => expect(harness.wallet.deriveNewAccountFromMnemonic).toHaveBeenCalledTimes(1));
  });

  it('reports a created account whose floor scan is still pending with the translated warning, and closes', async () => {
    // A restored wallet commits the account before its floor scan; when the
    // scan does not complete the derive resolves with the signing gate shut.
    harness.wallet.deriveNewAccountFromMnemonic.mockResolvedValueOnce({
      floorScanPending: true,
      floorScanError: 'qbit address history changed while scanning qb1x'
    });
    const { onClose } = await renderSheet(twoWallets());
    await openFromPlus('keyring_1');

    fireEvent.click(createButton());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(harness.tools.toastWarning).toHaveBeenCalledWith('qbit_restore_floors_incomplete_warning');
    expect(harness.tools.toastSuccess).not.toHaveBeenCalled();
    expect(harness.tools.toastError).not.toHaveBeenCalled();
    expect(harness.reloadAccounts).toHaveBeenCalledTimes(1);
    expect(newAccountDialog()).toBeNull();
  });

  it('counts a derive that resolves with nothing as created', async () => {
    harness.wallet.deriveNewAccountFromMnemonic.mockResolvedValueOnce(undefined);
    const { onClose } = await renderSheet(twoWallets());
    await openFromPlus('keyring_1');

    fireEvent.click(createButton());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(harness.tools.toastSuccess).toHaveBeenCalledWith('account_created');
    expect(harness.reloadAccounts).toHaveBeenCalledTimes(1);
  });

  it('reports a refused derive, reads the accounts back and closes only the dialog, never deriving again', async () => {
    // A restored wallet commits the account before its floor scan, and a
    // request a dropped port rejected may still complete: the account may
    // exist, so nothing offers to derive it again. Errors cross the UI port
    // as plain objects.
    harness.wallet.deriveNewAccountFromMnemonic.mockRejectedValueOnce({ message: 'floor scan failed', stack: 'at …' });
    const reload = deferred<void>();
    harness.reloadAccounts.mockReturnValueOnce(reload.promise);
    const { onClose } = await renderSheet(twoWallets());
    const plus = await openFromPlus('keyring_1');

    fireEvent.click(createButton());
    fireEvent.click(createButton());
    await waitFor(() => expect(harness.tools.toastError).toHaveBeenCalledWith('floor scan failed'));
    // Refused, and the accounts are still being read back.
    fireEvent.click(createButton());
    fireEvent.keyDown(nameField(), { key: 'Enter' });
    fireEvent.keyDown(nameField(), { key: 'Enter', repeat: true });
    fireEvent.click(plus);
    expect(createButton().getAttribute('aria-disabled')).toBe('true');
    await act(async () => reload.resolve());

    await waitFor(() => expect(newAccountDialog()).toBeNull());
    expect(document.activeElement).toBe(plus);
    expect(harness.wallet.deriveNewAccountFromMnemonic).toHaveBeenCalledTimes(1);
    expect(harness.reloadAccounts).toHaveBeenCalledTimes(1);
    // The wallet is still listed, so the background's message stands.
    expect(harness.wallet.getKeyrings).toHaveBeenCalledTimes(2);
    expect(harness.tools.toastError).toHaveBeenCalledTimes(1);
    expect(harness.tools.toastSuccess).not.toHaveBeenCalled();
    await waitPastCloseAnimation();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('switch-account-sheet')).toBeTruthy();
  });

  it('says in the user language that the wallet is gone when its derive is refused, and closes only the dialog', async () => {
    const keyrings = twoWallets();
    const { onClose } = await renderSheet(keyrings);
    await openFromPlus('keyring_1');
    // Another window removed the wallet after this sheet read the wallets; the
    // background refuses before it derives anything. Its message is English.
    harness.wallet.deriveNewAccountFromMnemonic.mockRejectedValueOnce({
      message: 'The selected wallet is no longer available',
      stack: 'at …'
    });
    harness.wallet.getKeyrings.mockResolvedValue([keyrings[0]]);

    fireEvent.click(createButton());

    await waitFor(() => expect(harness.tools.toastError).toHaveBeenCalledWith('account_switcher_wallet_unavailable'));
    expect(harness.tools.toastError).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(newAccountDialog()).toBeNull());
    // The wallets read again: the sheet lists the ones there are, focus in it.
    expect(screen.queryByTestId('wallet-group-keyring_1')).toBeNull();
    expect(rowIds()).toEqual([keyrings[0].accounts[0].address]);
    expect(document.activeElement).toBe(screen.getByTestId('switch-account-search'));
    await waitFor(() => expect(harness.reloadAccounts).toHaveBeenCalledTimes(1));
    expect(harness.wallet.deriveNewAccountFromMnemonic).toHaveBeenCalledTimes(1);
    await waitPastCloseAnimation();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('switch-account-sheet')).toBeTruthy();
  });

  it('keeps the message of the background for a refused derive when the wallets cannot be read again', async () => {
    const { onClose } = await renderSheet(twoWallets());
    const plus = await openFromPlus('keyring_1');
    harness.wallet.deriveNewAccountFromMnemonic.mockRejectedValueOnce({
      message: 'The selected wallet is no longer available'
    });
    harness.wallet.getKeyrings.mockRejectedValueOnce({ message: 'port closed' });

    fireEvent.click(createButton());

    await waitFor(() => expect(newAccountDialog()).toBeNull());
    expect(harness.tools.toastError).toHaveBeenCalledTimes(1);
    expect(harness.tools.toastError).toHaveBeenCalledWith('The selected wallet is no longer available');
    expect(document.activeElement).toBe(plus);
    expect(screen.getByTestId('wallet-group-keyring_1')).toBeTruthy();
    expect(harness.reloadAccounts).toHaveBeenCalledTimes(1);
    await waitPastCloseAnimation();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes only the dialog when reading the accounts back fails after a refused derive', async () => {
    harness.wallet.deriveNewAccountFromMnemonic.mockRejectedValueOnce({ message: 'floor scan failed' });
    harness.reloadAccounts.mockRejectedValueOnce({ message: 'port closed' });
    const { onClose } = await renderSheet(twoWallets());
    const plus = await openFromPlus('keyring_1');

    fireEvent.click(createButton());

    await waitFor(() => expect(newAccountDialog()).toBeNull());
    expect(harness.tools.toastError).toHaveBeenCalledTimes(1);
    expect(harness.tools.toastError).toHaveBeenCalledWith('floor scan failed');
    expect(document.activeElement).toBe(plus);
    expect(harness.wallet.deriveNewAccountFromMnemonic).toHaveBeenCalledTimes(1);
    await waitPastCloseAnimation();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes the dialog and the sheet when reading the accounts back fails after the account was created', async () => {
    harness.reloadAccounts.mockRejectedValueOnce({ message: 'port closed' });
    const { onClose } = await renderSheet(twoWallets());
    await openFromPlus('keyring_1');

    fireEvent.click(createButton());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(harness.tools.toastSuccess).toHaveBeenCalledWith('account_created');
    expect(harness.tools.toastError).not.toHaveBeenCalled();
    expect(harness.wallet.deriveNewAccountFromMnemonic).toHaveBeenCalledTimes(1);
  });

  it('closes, focus back in the sheet, when its wallet is removed elsewhere before Create', async () => {
    const keyrings = twoWallets();
    const { onClose } = await renderSheet(keyrings);
    await openFromPlus('keyring_1');

    act(() => {
      harness.dispatch({ type: 'keyrings/setKeyrings', payload: [keyrings[0]] });
    });

    expect(newAccountDialog()).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('switch-account-search'));
    await waitPastCloseAnimation();
    expect(onClose).not.toHaveBeenCalled();
    expect(harness.wallet.deriveNewAccountFromMnemonic).not.toHaveBeenCalled();
  });

  type Derive = ReturnType<typeof deferred<{ floorScanPending: boolean }>>;

  it.each([
    ['created', (derive: Derive) => derive.resolve({ floorScanPending: false })],
    ['refused', (derive: Derive) => derive.reject({ message: 'floor scan failed' })]
  ])(
    'lets a derive %s after its wallet was removed close nothing: not a dialog opened since, nor the sheet',
    async (_outcome, settle) => {
      const keyrings = twoWallets();
      const derive = deferred<{ floorScanPending: boolean }>();
      harness.wallet.deriveNewAccountFromMnemonic.mockReturnValueOnce(derive.promise);
      const { onClose } = await renderSheet(keyrings);
      await openFromPlus('keyring_1');
      fireEvent.click(createButton());

      // Another window removes the wallet while its account is derived.
      act(() => {
        harness.dispatch({ type: 'keyrings/setKeyrings', payload: [keyrings[0]] });
      });
      expect(newAccountDialog()).toBeNull();
      fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
      fireEvent.click(screen.getByTestId('wallet-menu-rename'));
      const renameField = screen.getByTestId('name-edit-input');
      expect(document.activeElement).toBe(renameField);

      await act(async () => settle(derive));

      // The store still follows the background.
      await waitFor(() => expect(harness.reloadAccounts).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId('name-edit-dialog')).toBeTruthy();
      expect(document.activeElement).toBe(renameField);
      await waitPastCloseAnimation();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByTestId('switch-account-sheet')).toBeTruthy();
    }
  );

  it('keeps the wallets read back after the derive over the reads that started before it', async () => {
    const keyrings = twoWallets();
    harness.reset({ keyrings, currentKeyring: keyrings[0], currentAccount: keyrings[0].accounts[0] });
    const openingRead = deferred<WalletKeyring[]>();
    // The read made on opening hangs; the one the refusal makes answers with
    // the wallets from before the account was saved.
    harness.wallet.getKeyrings.mockReturnValueOnce(openingRead.promise).mockResolvedValueOnce(keyrings);
    // Refused, yet created: a restored wallet commits the account before its
    // floor scan. The sheet stays open, with the wallets the reload reads.
    harness.wallet.deriveNewAccountFromMnemonic.mockRejectedValueOnce({ message: 'floor scan failed' });
    const withNewAccount = [keyrings[0], makeKeyring(1, KeyringType.QbitHdKeyring, 2)];
    harness.reloadAccounts.mockImplementationOnce(async () => {
      harness.dispatch({ type: 'keyrings/setKeyrings', payload: withNewAccount });
    });
    render(<AccountSwitcherSheet onClose={vi.fn()} />);
    await screen.findByTestId('switch-account-sheet');
    await openFromPlus('keyring_1');

    fireEvent.click(createButton());
    await waitFor(() => expect(newAccountDialog()).toBeNull());
    expect(harness.tools.toastError).toHaveBeenCalledWith('floor scan failed');
    expect(harness.wallet.getKeyrings).toHaveBeenCalledTimes(2);
    expect(harness.store.state.keyrings).toBe(withNewAccount);
    expect(rowIds()).toHaveLength(3);

    // The read made on opening settles last, without the new account.
    await act(async () => openingRead.resolve(keyrings));

    expect(harness.store.state.keyrings).toBe(withNewAccount);
    expect(rowIds()).toHaveLength(3);
  });

  it('keeps the wallets read back after a created account over the read made on opening, settling during the reload', async () => {
    const keyrings = twoWallets();
    harness.reset({ keyrings, currentKeyring: keyrings[0], currentAccount: keyrings[0].accounts[0] });
    const openingRead = deferred<WalletKeyring[]>();
    harness.wallet.getKeyrings.mockReturnValueOnce(openingRead.promise);
    // The reload stores the wallets it read first, then reads the selection.
    const withNewAccount = [keyrings[0], makeKeyring(1, KeyringType.QbitHdKeyring, 2)];
    const restOfReload = deferred<void>();
    harness.reloadAccounts.mockImplementationOnce(async () => {
      harness.dispatch({ type: 'keyrings/setKeyrings', payload: withNewAccount });
      await restOfReload.promise;
    });
    const onClose = vi.fn();
    render(<AccountSwitcherSheet onClose={onClose} />);
    await screen.findByTestId('switch-account-sheet');
    await openFromPlus('keyring_1');

    fireEvent.click(createButton());
    await waitFor(() => expect(harness.store.state.keyrings).toBe(withNewAccount));
    // The read made on opening settles while the reload still runs, without
    // the new account.
    await act(async () => openingRead.resolve(keyrings));
    expect(harness.store.state.keyrings).toBe(withNewAccount);

    await act(async () => restOfReload.resolve());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(harness.store.state.keyrings).toBe(withNewAccount);
  });

  it('still reports the result and reads the accounts back when the sheet is gone before the derive settles', async () => {
    const derive = deferred<{ floorScanPending: boolean }>();
    harness.wallet.deriveNewAccountFromMnemonic.mockReturnValueOnce(derive.promise);
    const { onClose, unmount } = await renderSheet(twoWallets());
    await openFromPlus('keyring_1');
    fireEvent.click(createButton());

    unmount();
    await act(async () => derive.resolve({ floorScanPending: false }));

    await waitFor(() => expect(harness.reloadAccounts).toHaveBeenCalledTimes(1));
    expect(harness.tools.toastSuccess).toHaveBeenCalledWith('account_created');
    expect(onClose).not.toHaveBeenCalled();
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
  // The removal would leave no wallet to open: the switcher reads the wallets
  // again, then offers the reset in its place, and sends nothing before the
  // user confirms it there.
  const expectResetOffered = async () => {
    expect(await screen.findByRole('dialog', { name: 'reset_wallet' })).toBeTruthy();
    expect(screen.getByTestId('reset-wallet-last-wallet').textContent).toBe('reset_wallet_last_wallet');
    expect(screen.queryByText('please_pay_attention_to_whether_you_have_backed_up')).toBeNull();
    expect(harness.tools.toastError).not.toHaveBeenCalled();
    expect(harness.wallet.removeKeyring).not.toHaveBeenCalled();
    expect(harness.wallet.resetWallet).not.toHaveBeenCalled();
  };

  it('removing the last wallet opens the reset confirmation', async () => {
    await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1)]);
    harness.wallet.resetWallet.mockReturnValue(new Promise(() => undefined));

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));
    await expectResetOffered();
    expect(screen.queryByRole('menu')).toBeNull();
    // Read once on opening, and again before the reset was offered.
    expect(harness.wallet.getKeyrings).toHaveBeenCalledTimes(2);

    // Only the confirmation sends it, with the typed password, naming the
    // wallet it was offered for so the background checks it again.
    fireEvent.change(screen.getByTestId('reset-wallet-password-input'), { target: { value: 'hunter22' } });
    expect(harness.wallet.resetWallet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('reset-wallet-confirm-button'));

    expect(harness.wallet.resetWallet).toHaveBeenCalledTimes(1);
    expect(harness.wallet.resetWallet).toHaveBeenCalledWith('hunter22', { lastWalletKey: 'keyring_0' });
    expect(harness.wallet.removeKeyring).not.toHaveBeenCalled();
    expect(harness.tools.toastError).not.toHaveBeenCalled();
  });

  // As in the background, a usable wallet must stay: a corrupted one cannot be
  // opened, so it does not count.
  it('treats the only usable wallet beside a corrupted one as the last, but not the corrupted one', async () => {
    const broken = makeKeyring(2, KeyringType.QbitHdKeyring, 0, { isCorrupted: true, alianName: 'Broken' });
    await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1), broken]);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));
    await expectResetOffered();
    fireEvent.click(screen.getByTestId('reset-wallet-cancel-button'));
    expect(screen.queryByRole('dialog', { name: 'reset_wallet' })).toBeNull();

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_2'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));
    expect(screen.getByText('please_pay_attention_to_whether_you_have_backed_up')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'reset_wallet' })).toBeNull();
    expect(harness.tools.toastError).not.toHaveBeenCalled();
    expect(harness.wallet.removeKeyring).not.toHaveBeenCalled();
    expect(harness.wallet.resetWallet).not.toHaveBeenCalled();
  });

  it('offers the reset for any wallet when no wallet is usable', async () => {
    await renderSheet([
      makeKeyring(0, KeyringType.HdKeyring, 0, { isCorrupted: true }),
      makeKeyring(1, KeyringType.QbitHdKeyring, 0, { isCorrupted: true })
    ]);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_1'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));

    await expectResetOffered();
  });

  it('closes the reset confirmation with Escape, sending nothing and keeping the sheet open', async () => {
    const { onClose } = await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1)]);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));
    const dialog = await screen.findByRole('dialog', { name: 'reset_wallet' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.change(screen.getByTestId('reset-wallet-password-input'), { target: { value: 'hunter22' } });
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'reset_wallet' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('wallet-menu-keyring_0'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(onClose).not.toHaveBeenCalled();
    expect(harness.wallet.resetWallet).not.toHaveBeenCalled();
    expect(harness.wallet.removeKeyring).not.toHaveBeenCalled();
  });

  // Another window added a wallet while the reset confirmation was open: the
  // switcher's own list shows it, and removing this wallet no longer resets.
  it('closes the last-wallet reset confirmation once another usable wallet is listed', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1)];
    await renderSheet(keyrings);
    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));
    expect(await screen.findByRole('dialog', { name: 'reset_wallet' })).toBeTruthy();

    // A corrupted wallet is no usable one: the premise holds.
    const broken = makeKeyring(2, KeyringType.QbitHdKeyring, 0, { isCorrupted: true, alianName: 'Broken' });
    act(() => {
      harness.dispatch({ type: 'keyrings/setKeyrings', payload: [...keyrings, broken] });
    });
    expect(screen.getByRole('dialog', { name: 'reset_wallet' })).toBeTruthy();

    const added = makeKeyring(1, KeyringType.QbitHdKeyring, 1);
    act(() => {
      harness.dispatch({ type: 'keyrings/setKeyrings', payload: [...keyrings, broken, added] });
    });

    expect(screen.queryByRole('dialog', { name: 'reset_wallet' })).toBeNull();
    // It says why it went.
    expect(harness.tools.toastError).toHaveBeenCalledWith('wallet_reset_not_last_wallet');
    expect(document.activeElement).toBe(screen.getByTestId('wallet-menu-keyring_0'));
    // Remove Wallet is an ordinary removal again.
    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));
    expect(screen.getByText('please_pay_attention_to_whether_you_have_backed_up')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'reset_wallet' })).toBeNull();
    expect(harness.wallet.resetWallet).not.toHaveBeenCalled();
    expect(harness.wallet.removeKeyring).not.toHaveBeenCalled();
  });

  it('shows a reset it already sent to its end, then closes the outdated confirmation', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1)];
    await renderSheet(keyrings);
    const answer = deferred<void>();
    harness.wallet.resetWallet.mockReturnValueOnce(answer.promise);
    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));
    await screen.findByRole('dialog', { name: 'reset_wallet' });
    fireEvent.change(screen.getByTestId('reset-wallet-password-input'), { target: { value: 'hunter22' } });
    fireEvent.click(screen.getByTestId('reset-wallet-confirm-button'));

    const added = makeKeyring(1, KeyringType.QbitHdKeyring, 1);
    act(() => {
      harness.dispatch({ type: 'keyrings/setKeyrings', payload: [...keyrings, added] });
    });
    expect(screen.getByRole('dialog', { name: 'reset_wallet' })).toBeTruthy();

    await act(async () => answer.reject({ message: 'Password is incorrect' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'reset_wallet' })).toBeNull());
    // Not silently: the background's answer is shown as the dialog goes.
    expect(harness.tools.toastError).toHaveBeenCalledWith('Password is incorrect');
    expect(harness.wallet.resetWallet).toHaveBeenCalledTimes(1);
  });

  it('closes an outdated reset that the background answers with -11, saying why, with no risk step', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1)];
    await renderSheet(keyrings);
    const answer = deferred<void>();
    harness.wallet.resetWallet.mockReturnValueOnce(answer.promise);
    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));
    await screen.findByRole('dialog', { name: 'reset_wallet' });
    fireEvent.change(screen.getByTestId('reset-wallet-password-input'), { target: { value: 'hunter22' } });
    fireEvent.click(screen.getByTestId('reset-wallet-confirm-button'));
    const added = makeKeyring(1, KeyringType.QbitHdKeyring, 1);
    act(() => {
      harness.dispatch({ type: 'keyrings/setKeyrings', payload: [...keyrings, added] });
    });

    await act(async () =>
      answer.reject({
        code: -11,
        data: { reasons: [{ role: 'destination', network: 'regtest', status: 'migrating' }] }
      })
    );

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'reset_wallet' })).toBeNull());
    expect(screen.queryByText('reset_wallet_recovery_title')).toBeNull();
    expect(harness.tools.toastError).toHaveBeenCalledWith('wallet_reset_not_last_wallet');
    expect(harness.wallet.resetWallet).toHaveBeenCalledTimes(1);
  });

  // Another window added a wallet after this sheet read the wallets: the read
  // before the reset is offered finds it, as a fresh list would show it.
  it('reads the wallets again before offering the reset, and offers the removal when another usable wallet turned up', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1)];
    await renderSheet(keyrings);
    harness.wallet.getKeyrings.mockResolvedValue([...keyrings, makeKeyring(1, KeyringType.QbitHdKeyring, 1)]);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));

    expect(await screen.findByText('please_pay_attention_to_whether_you_have_backed_up')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'reset_wallet' })).toBeNull();
    expect(harness.wallet.getKeyrings).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('wallet-group-keyring_1')).toBeTruthy();
    expect(harness.wallet.resetWallet).not.toHaveBeenCalled();
    expect(harness.wallet.removeKeyring).not.toHaveBeenCalled();
  });

  it('offers nothing when the fresh list no longer has the wallet', async () => {
    await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1)]);
    harness.wallet.getKeyrings.mockResolvedValue([makeKeyring(1, KeyringType.QbitHdKeyring, 1)]);

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));

    await waitFor(() => expect(screen.queryByTestId('wallet-group-keyring_0')).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'reset_wallet' })).toBeNull();
    expect(screen.queryByText('please_pay_attention_to_whether_you_have_backed_up')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('switch-account-search'));
  });

  it('judges from the list it has when the read fails, and the background checks again', async () => {
    await renderSheet([makeKeyring(0, KeyringType.QbitHdKeyring, 1)]);
    harness.wallet.getKeyrings.mockRejectedValue({ message: 'port gone' });
    harness.wallet.resetWallet.mockReturnValue(new Promise(() => undefined));

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));
    await expectResetOffered();
    fireEvent.change(screen.getByTestId('reset-wallet-password-input'), { target: { value: 'hunter22' } });
    fireEvent.click(screen.getByTestId('reset-wallet-confirm-button'));

    expect(harness.wallet.resetWallet).toHaveBeenCalledWith('hunter22', { lastWalletKey: 'keyring_0' });
  });

  // The background found another usable wallet inside the reset and erased
  // nothing (WALLET_RESET_NOT_LAST_WALLET).
  it('closes the reset, shows why, and reads the wallets again when the wallet is no longer the last', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1)];
    await renderSheet(keyrings);
    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));
    await expectResetOffered();
    harness.wallet.getKeyrings.mockResolvedValue([...keyrings, makeKeyring(1, KeyringType.QbitHdKeyring, 1)]);
    harness.wallet.resetWallet.mockRejectedValue({ code: -20, message: 'wallet_reset_not_last_wallet' });

    fireEvent.change(screen.getByTestId('reset-wallet-password-input'), { target: { value: 'hunter22' } });
    fireEvent.click(screen.getByTestId('reset-wallet-confirm-button'));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'reset_wallet' })).toBeNull());
    expect(harness.tools.toastError).toHaveBeenCalledWith('wallet_reset_not_last_wallet');
    expect(await screen.findByTestId('wallet-group-keyring_1')).toBeTruthy();
    expect(harness.wallet.getKeyrings).toHaveBeenCalledTimes(3);
    // The menu now has the truth: Remove Wallet is an ordinary removal.
    fireEvent.click(screen.getByTestId('wallet-menu-keyring_0'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));
    expect(screen.getByText('please_pay_attention_to_whether_you_have_backed_up')).toBeTruthy();
    expect(harness.wallet.resetWallet).toHaveBeenCalledTimes(1);
  });

  // Another window removed the other wallet meanwhile: the background refuses
  // the removal, and the refusal stays a refusal.
  it('never turns a refused removal into a reset', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.QbitHdKeyring, 1)];
    await renderSheet(keyrings);
    harness.wallet.removeKeyring.mockRejectedValue({ message: 'removing_the_last_wallet_is_not_allowed' });

    fireEvent.click(screen.getByTestId('wallet-menu-keyring_1'));
    fireEvent.click(screen.getByTestId('wallet-menu-remove'));
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(harness.tools.toastError).toHaveBeenCalledWith('removing_the_last_wallet_is_not_allowed'));
    await waitFor(() => expect(screen.queryByText('please_pay_attention_to_whether_you_have_backed_up')).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'reset_wallet' })).toBeNull();
    expect(harness.wallet.removeKeyring).toHaveBeenCalledTimes(1);
    expect(harness.wallet.resetWallet).not.toHaveBeenCalled();
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
    expect(screen.queryByRole('dialog', { name: 'reset_wallet' })).toBeNull();
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(screen.queryByTestId('wallet-group-keyring_1')).toBeNull());
    expect(harness.wallet.removeKeyring).toHaveBeenCalledWith(keyrings[1], undefined);
    expect(harness.wallet.resetWallet).not.toHaveBeenCalled();
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
    // The wrapper that draws its focus cue, as for the New account dialog's field.
    expect(input.closest('.switcher-dialog__field')).not.toBeNull();
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

  it('renames an account, and closes the dialog with the error when the background refuses', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 2)];
    const account = keyrings[0].accounts[0];
    harness.wallet.setAccountAlianName.mockRejectedValueOnce({ message: 'storage is locked' });
    await renderSheet(keyrings);

    fireEvent.click(screen.getByTestId(`account-menu-${account.address}`));
    fireEvent.click(screen.getByTestId('account-menu-edit-name'));
    fireEvent.change(screen.getByTestId('name-edit-input'), { target: { value: 'Rent' } });
    fireEvent.submit(screen.getByTestId('name-edit-input').closest('form') as HTMLFormElement);

    await waitFor(() => expect(harness.tools.toastError).toHaveBeenCalledWith('storage is locked'));
    await waitFor(() => expect(screen.queryByTestId('name-edit-dialog')).toBeNull());

    // A retry starts again from the account's menu.
    fireEvent.click(screen.getByTestId(`account-menu-${account.address}`));
    fireEvent.click(screen.getByTestId('account-menu-edit-name'));
    fireEvent.change(screen.getByTestId('name-edit-input'), { target: { value: 'Rent' } });
    fireEvent.click(screen.getByTestId('name-edit-save'));
    await waitFor(() => expect(screen.queryByTestId('name-edit-dialog')).toBeNull());
    expect(harness.wallet.setAccountAlianName).toHaveBeenCalledTimes(2);
    expect(harness.wallet.setAccountAlianName).toHaveBeenLastCalledWith(account, 'Rent');
    expect(screen.getByTestId(`account-row-${account.address}`).textContent).toContain('Rent');
    expect(harness.store.state.currentAccount.alianName).toBe('Rent');
  });

  it('explains a refused account rename as a refused wallet rename when the wallet is gone, and reads the wallets again', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1), makeKeyring(1, KeyringType.QbitHdKeyring, 1)];
    const account = keyrings[1].accounts[0];
    await renderSheet(keyrings);
    // Another window removed the second wallet after the sheet read the wallets.
    harness.wallet.getKeyrings.mockResolvedValue([keyrings[0]]);
    harness.wallet.setAccountAlianName.mockRejectedValueOnce({
      message: 'The selected account is no longer available'
    });

    fireEvent.click(screen.getByTestId(`account-menu-${account.address}`));
    fireEvent.click(screen.getByTestId('account-menu-edit-name'));
    fireEvent.change(screen.getByTestId('name-edit-input'), { target: { value: 'Rent' } });
    fireEvent.submit(screen.getByTestId('name-edit-input').closest('form') as HTMLFormElement);

    // In the user's language, not the background's.
    await waitFor(() => expect(harness.tools.toastError).toHaveBeenCalledWith('account_switcher_wallet_unavailable'));
    await waitFor(() => expect(screen.queryByTestId('wallet-group-keyring_1')).toBeNull());
    expect(screen.queryByTestId('name-edit-dialog')).toBeNull();
  });

  it('closes the dialog on a refused account rename and reads the wallets again, so a retry names the account they now list', async () => {
    const keyrings = [makeKeyring(0, KeyringType.QbitHdKeyring, 1)];
    const stale = keyrings[0].accounts[0];
    await renderSheet(keyrings);
    // The slot holds another wallet now, its account under the same key.
    const fresh = { ...stale, address: `${stale.address}new`, pubkey: `${stale.pubkey}new` };
    harness.wallet.getKeyrings.mockResolvedValue([{ ...keyrings[0], accounts: [fresh] }]);
    harness.wallet.setAccountAlianName.mockRejectedValueOnce({
      message: 'The selected account is no longer available'
    });

    fireEvent.click(screen.getByTestId(`account-menu-${stale.address}`));
    fireEvent.click(screen.getByTestId('account-menu-edit-name'));
    fireEvent.change(screen.getByTestId('name-edit-input'), { target: { value: 'Rent' } });
    fireEvent.submit(screen.getByTestId('name-edit-input').closest('form') as HTMLFormElement);

    await waitFor(() =>
      expect(harness.tools.toastError).toHaveBeenCalledWith('The selected account is no longer available')
    );
    // The dialog would find its account again by keys only, which the fresh
    // account holds now: it closes rather than offer a save that names it.
    await waitFor(() => expect(screen.queryByTestId('name-edit-dialog')).toBeNull());
    await waitFor(() => expect(screen.getByTestId(`account-row-${fresh.address}`)).toBeTruthy());

    // A retry starts from the row the wallets now list.
    fireEvent.click(screen.getByTestId(`account-menu-${fresh.address}`));
    fireEvent.click(screen.getByTestId('account-menu-edit-name'));
    fireEvent.change(screen.getByTestId('name-edit-input'), { target: { value: 'Rent' } });
    fireEvent.click(screen.getByTestId('name-edit-save'));
    await waitFor(() => expect(screen.queryByTestId('name-edit-dialog')).toBeNull());
    expect(harness.wallet.setAccountAlianName).toHaveBeenCalledTimes(2);
    expect(harness.wallet.setAccountAlianName).toHaveBeenLastCalledWith(
      expect.objectContaining({ address: fresh.address }),
      'Rent'
    );
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

    tapDimmedPage();
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
