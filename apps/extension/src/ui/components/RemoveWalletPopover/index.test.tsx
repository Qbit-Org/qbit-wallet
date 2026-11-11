import { useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { KeyringType } from '@qbit/keyring-service/types';
import { ErrorCodes, type WalletKeyring } from '@qbit/wallet-shared';
import { useAppDispatch, useCurrentAccount, useI18n, useNavigation, useTools, useWallet } from '@qbit/wallet-state';

import { RemoveWalletPopover } from './index';

type CurrentAccount = ReturnType<typeof useCurrentAccount>;
type Wallet = ReturnType<typeof useWallet>;

async function mockContainer(name: string) {
  const React = await import('react');
  const Container = ({
    children,
    style,
    onClick
  }: {
    children?: ReactNode;
    style?: CSSProperties;
    onClick?: (event: unknown) => void;
  }) => React.createElement('div', { style, onClick }, children);
  return { [name]: Container };
}

vi.mock('../Button', async () => {
  const React = await import('react');
  return {
    Button: ({
      text,
      onClick,
      ...props
    }: {
      text?: string;
      onClick?: (event: unknown) => void;
      'aria-disabled'?: boolean;
      'data-testid'?: string;
    }) =>
      React.createElement(
        'div',
        { onClick, 'aria-disabled': props['aria-disabled'], 'data-testid': props['data-testid'] },
        text
      )
  };
});
vi.mock('../Input', async () => {
  const React = await import('react');
  return {
    Input: ({
      onChange,
      ...props
    }: {
      onChange?: (event: unknown) => void;
      'data-testid'?: string;
    }) => React.createElement('input', { onChange, 'data-testid': props['data-testid'] })
  };
});
vi.mock('../Card', () => mockContainer('Card'));
vi.mock('../Column', () => mockContainer('Column'));
vi.mock('../Popover', () => mockContainer('Popover'));
vi.mock('../Row', () => mockContainer('Row'));
vi.mock('../Text', async () => {
  const React = await import('react');
  return {
    Text: ({ text }: { text?: string }) => React.createElement('span', null, text)
  };
});

vi.mock('@/ui/utils', () => ({
  shortAddress: (value = '') => value
}));

vi.mock('@qbit/wallet-state', () => ({
  accountActions: { setCurrent: (payload: unknown) => ({ type: 'account/setCurrent', payload }) },
  keyringsActions: {
    setKeyrings: (payload: unknown) => ({ type: 'keyrings/setKeyrings', payload }),
    setCurrent: (payload: unknown) => ({ type: 'keyrings/setCurrent', payload })
  },
  useAppDispatch: vi.fn(),
  useCurrentAccount: vi.fn(),
  useI18n: vi.fn(),
  useNavigation: vi.fn(),
  useTools: vi.fn(),
  useWallet: vi.fn()
}));

const account = {
  address: 'tq1qremoved',
  alianName: 'Account 1',
  flag: 0,
  index: 0,
  key: 'keyring_1#0',
  pubkey: 'account-pubkey',
  type: KeyringType.QbitHdKeyring
};
const keyring = {
  accountIndexDerivation: false,
  accounts: [account],
  addressType: 9,
  alianName: 'Wallet 2',
  hdPath: `m/87'/1'/0'/0`,
  index: 1,
  key: 'keyring_1',
  type: KeyringType.QbitHdKeyring
};
// The wallet the background switches to when the current one is removed.
const nextAccount = { ...account, address: 'tq1qnext', key: 'keyring_0#0', pubkey: 'next-pubkey' };
const nextKeyring = { ...keyring, alianName: 'Wallet 1', index: 0, key: 'keyring_0', accounts: [nextAccount] };

// The background once a removal is saved: the wallets it lists, and the
// account it has selected, still unlocked.
const afterRemoval = (keyrings: unknown[], selected: unknown) => ({
  getKeyrings: vi.fn().mockResolvedValue(keyrings),
  getCurrentAccount: vi.fn().mockResolvedValue(selected),
  isUnlocked: vi.fn().mockResolvedValue(true)
});

// A wallet in slot `index` with one account, which another window can make current.
const walletInSlot = (index: number) => {
  const held = { ...account, address: `tq1qslot${index}`, key: `keyring_${index}#0`, pubkey: `slot-${index}` };
  return { ...keyring, alianName: `Wallet ${index + 1}`, index, key: `keyring_${index}`, accounts: [held] };
};

/**
 * The store's current wallet and account, starting from the removed wallet
 * and its account, and every pair a render showed: a component reading them
 * renders once for each change the dispatches make.
 */
function selectionShown() {
  type Named = { key: string };
  let state = { wallet: keyring as Named, account: account as Named };
  const listeners = new Set<() => void>();
  const rendered: string[] = [];
  const dispatchToStore = vi.fn((action: { type: string; payload: Named }) => {
    if (action.type === 'keyrings/setCurrent') state = { ...state, wallet: action.payload };
    if (action.type === 'account/setCurrent') state = { ...state, account: action.payload };
    listeners.forEach((listener) => listener());
  });
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  function Selection() {
    const shown = useSyncExternalStore(subscribe, () => state);
    rendered.push(`${shown.wallet.key} ${shown.account.key}`);
    return null;
  }
  // The pairs shown with an account of another wallet.
  const mixed = () => rendered.filter((pair) => !pair.split(' ')[1].startsWith(`${pair.split(' ')[0]}#`));
  return { dispatch: dispatchToStore, Selection, rendered, mixed };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('RemoveWalletPopover remove action', () => {
  const dispatch = vi.fn();
  const navigate = vi.fn();
  const navToLock = vi.fn();
  const toastError = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    vi.mocked(useAppDispatch).mockReturnValue(dispatch as any);
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useNavigation).mockReturnValue({ navigate, navToLock } as any);
    vi.mocked(useTools).mockReturnValue({ toastError } as any);
    // The wallet being removed is the current one, unless a test says otherwise.
    vi.mocked(useCurrentAccount).mockReturnValue(account as unknown as CurrentAccount);
  });

  it('surfaces a background refusal instead of silently doing nothing', async () => {
    vi.mocked(useWallet).mockReturnValue({
      removeKeyring: vi.fn().mockRejectedValue({ message: 'qbit_recovery_wallets_retained' }),
      getKeyrings: vi.fn()
    } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('qbit_recovery_wallets_retained'));
    expect(onClose).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  // The background keeps a usable wallet, so it refuses a removal another
  // window made the last one, with its message.
  it('shows the refusal to remove the last usable wallet and changes nothing', async () => {
    const wallet = {
      removeKeyring: vi.fn().mockRejectedValue({ message: 'removing_the_last_wallet_is_not_allowed' }),
      getKeyrings: vi.fn()
    };
    vi.mocked(useWallet).mockReturnValue(wallet as unknown as ReturnType<typeof useWallet>);

    render(<RemoveWalletPopover keyring={keyring as unknown as WalletKeyring} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('removing_the_last_wallet_is_not_allowed'));
    expect(onClose).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('falls back to a generic error when the rejection carries no message', async () => {
    vi.mocked(useWallet).mockReturnValue({
      removeKeyring: vi.fn().mockRejectedValue({}),
      getKeyrings: vi.fn()
    } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('unknown_error'));
    expect(onClose).toHaveBeenCalled();
  });

  it('updates keyring state without toasting when removal succeeds', async () => {
    vi.mocked(useWallet).mockReturnValue({
      removeKeyring: vi.fn().mockResolvedValue(nextKeyring),
      ...afterRemoval([nextKeyring], nextAccount)
    } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: 'account/setCurrent', payload: nextAccount })
    );
    expect(dispatch).toHaveBeenCalledWith({ type: 'keyrings/setKeyrings', payload: [nextKeyring] });
    // The wallet the background switched to becomes current with its account,
    // so the home card never names one wallet above another's account.
    expect(dispatch).toHaveBeenCalledWith({ type: 'keyrings/setCurrent', payload: nextKeyring });
    expect(toastError).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  // A read that started before the removal can settle after it and still
  // list the removed wallet, and the wallet current read back with it.
  it('neither shows nor makes current the removed wallet when the wallets read still list it', async () => {
    const wallet = {
      removeKeyring: vi.fn().mockResolvedValue(nextKeyring),
      ...afterRemoval([nextKeyring, keyring], account),
      getCurrentKeyring: vi.fn().mockResolvedValue(keyring)
    };
    vi.mocked(useWallet).mockReturnValue(wallet as unknown as Wallet);

    render(<RemoveWalletPopover keyring={keyring as unknown as WalletKeyring} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() =>
      expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
        { type: 'keyrings/setKeyrings', payload: [nextKeyring] },
        { type: 'keyrings/setCurrent', payload: nextKeyring },
        { type: 'account/setCurrent', payload: nextAccount }
      ])
    );
    expect(toastError).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  // Removing a wallet that is not current leaves the current wallet and
  // account as they were: the store keeps the account the background kept,
  // not the wallet's first one.
  it('keeps the current account when another wallet is removed', async () => {
    const first = { ...account, address: 'tq1qkeptfirst', key: 'keyring_0#0', pubkey: 'kept-0' };
    const second = { ...account, address: 'tq1qkeptsecond', key: 'keyring_0#1', index: 1, pubkey: 'kept-1' };
    const kept = { ...nextKeyring, accounts: [first, second] };
    vi.mocked(useCurrentAccount).mockReturnValue(second as unknown as CurrentAccount);
    const wallet = { removeKeyring: vi.fn().mockResolvedValue(kept), ...afterRemoval([kept], second) };
    vi.mocked(useWallet).mockReturnValue(wallet as unknown as Wallet);

    render(<RemoveWalletPopover keyring={keyring as unknown as WalletKeyring} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'account/setCurrent', payload: second }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'keyrings/setCurrent', payload: kept });
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'account/setCurrent', payload: first });
    expect(wallet.getCurrentAccount).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    ['the account shown, when the wallet holds it', 'keyring_0#1', 1],
    ['the first account of the wallet, when the shown account was in the removed wallet', 'keyring_1#0', 0]
  ])(
    'falls back to %s when the selected account cannot be read',
    async (_which, shownKey, expected) => {
      const accounts = [0, 1].map((index) => ({
        ...account,
        address: `tq1qkept${index}`,
        key: `keyring_0#${index}`,
        index,
        pubkey: `kept-${index}`
      }));
      const kept = { ...nextKeyring, accounts };
      vi.mocked(useCurrentAccount).mockReturnValue({ ...account, key: shownKey } as unknown as CurrentAccount);
      vi.mocked(useWallet).mockReturnValue({
        removeKeyring: vi.fn().mockResolvedValue(kept),
        getKeyrings: vi.fn().mockResolvedValue([kept]),
        getCurrentAccount: vi.fn().mockRejectedValue(new Error('background unreachable')),
        isUnlocked: vi.fn().mockResolvedValue(true)
      } as unknown as Wallet);

      render(<RemoveWalletPopover keyring={keyring as unknown as WalletKeyring} onClose={onClose} />);
      fireEvent.click(screen.getByText('remove'));

      await waitFor(() =>
        expect(dispatch).toHaveBeenCalledWith({ type: 'account/setCurrent', payload: accounts[expected] })
      );
      expect(dispatch).toHaveBeenCalledWith({ type: 'keyrings/setCurrent', payload: kept });
      expect(dispatch).toHaveBeenCalledTimes(3);
      expect(toastError).not.toHaveBeenCalled();
    }
  );

  it('reads the account the background selected before it shows the wallet, then shows both at once', async () => {
    const selected = deferred<unknown>();
    const wallet = {
      removeKeyring: vi.fn().mockResolvedValue(nextKeyring),
      ...afterRemoval([nextKeyring], null),
      getCurrentAccount: vi.fn(() => selected.promise)
    };
    vi.mocked(useWallet).mockReturnValue(wallet as unknown as Wallet);

    render(<RemoveWalletPopover keyring={keyring as unknown as WalletKeyring} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(wallet.getCurrentAccount).toHaveBeenCalled());
    // While the account is read, the removed wallet's account is still shown:
    // the wallet the background left current is not shown over it.
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();

    selected.resolve(nextAccount);
    await waitFor(() =>
      expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
        { type: 'keyrings/setKeyrings', payload: [nextKeyring] },
        { type: 'keyrings/setCurrent', payload: nextKeyring },
        { type: 'account/setCurrent', payload: nextAccount }
      ])
    );
  });

  // Another window switches to the wallet in slot 2 while the popover reads
  // the background, which then answers with that wallet's account.
  it.each([
    ['the wallet it switched to, read back, with the account selected there', walletInSlot(2), true, 'keyring_2 keyring_2#0'],
    // Switched again before the wallet was read back: that wallet is shown
    // with its own account, never with the account read before.
    ['the wallet read back, with its own account, when it switched again', walletInSlot(3), true, 'keyring_3 keyring_3#0'],
    ['the wallet read that holds the account, when the wallet cannot be read back', null, true, 'keyring_2 keyring_2#0'],
    // Nothing read holds the account: the wallet the removal returned stays,
    // with its own account.
    ['the wallet the removal returned, with its own account, when nothing read holds the account', null, false, 'keyring_0 keyring_0#0']
  ])('shows %s, and never a wallet with another wallet’s account', async (_which, readBack, listsIt, shown) => {
    const switchedTo = walletInSlot(2);
    const listed = listsIt ? [nextKeyring, switchedTo] : [nextKeyring];
    const selection = selectionShown();
    vi.mocked(useAppDispatch).mockReturnValue(selection.dispatch as unknown as ReturnType<typeof useAppDispatch>);
    const wallet = {
      removeKeyring: vi.fn().mockResolvedValue(nextKeyring),
      ...afterRemoval(listed, switchedTo.accounts[0]),
      getCurrentKeyring: readBack
        ? vi.fn().mockResolvedValue(readBack)
        : vi.fn().mockRejectedValue(new Error('background unreachable'))
    };
    vi.mocked(useWallet).mockReturnValue(wallet as unknown as Wallet);

    render(
      <>
        <selection.Selection />
        <RemoveWalletPopover keyring={keyring as unknown as WalletKeyring} onClose={onClose} />
      </>
    );
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(selection.rendered.at(-1)).toBe(shown));
    expect(selection.mixed()).toEqual([]);
    expect(selection.dispatch).toHaveBeenCalledWith({ type: 'keyrings/setKeyrings', payload: listed });
    expect(wallet.getCurrentKeyring).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  // The wallet the removal returned was read before the account: an account
  // under the same key with another address is not the one it holds.
  it('reads the wallet back when the account selected is not the one the returned wallet holds', async () => {
    const selected = { ...nextAccount, address: 'tq1qnextnow' };
    const now = { ...nextKeyring, accounts: [selected] };
    const wallet = {
      removeKeyring: vi.fn().mockResolvedValue(nextKeyring),
      ...afterRemoval([now], selected),
      getCurrentKeyring: vi.fn().mockResolvedValue(now)
    };
    vi.mocked(useWallet).mockReturnValue(wallet as unknown as Wallet);

    render(<RemoveWalletPopover keyring={keyring as unknown as WalletKeyring} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'account/setCurrent', payload: selected }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'keyrings/setCurrent', payload: now });
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'keyrings/setCurrent', payload: nextKeyring });
  });

  // The removal returns no wallet when other windows kept adding wallets
  // while it read them; the background still has one current.
  it('shows the wallet the background has current when the removal returned none', async () => {
    const added = walletInSlot(2);
    const wallet = {
      removeKeyring: vi.fn().mockResolvedValue(undefined),
      ...afterRemoval([nextKeyring, added], added.accounts[0]),
      getCurrentKeyring: vi.fn().mockResolvedValue(added)
    };
    vi.mocked(useWallet).mockReturnValue(wallet as unknown as Wallet);

    render(<RemoveWalletPopover keyring={keyring as unknown as WalletKeyring} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: 'account/setCurrent', payload: added.accounts[0] })
    );
    expect(dispatch).toHaveBeenCalledWith({ type: 'keyrings/setCurrent', payload: added });
    expect(navigate).not.toHaveBeenCalled();
  });

  // The removal returned no wallet, and the popover cannot read which wallet
  // the background has current either. The wallets read still hold usable
  // ones, so they are not taken for none: the store shows the last usable
  // wallet read, the one a removal makes current, with its own account.
  it.each([
    ['the account selected cannot be read', 'fails', 'not read'],
    ['no account reads as selected', 'none', 'not read'],
    ['the account selected is in a wallet not read, and the wallet current cannot be read back', 'unread', 'fails'],
    ['the account selected is in a wallet not read, and the wallet read back is the removed one', 'unread', 'removed'],
    ['the account selected is in a wallet not read, and no wallet reads back as current', 'unread', 'none']
  ])('shows the last usable wallet read when %s', async (_which, selected, readBack) => {
    const last = walletInSlot(2);
    const corrupted = { ...walletInSlot(3), accounts: [], isCorrupted: true };
    const listed = [nextKeyring, last, corrupted];
    const unread = walletInSlot(4);
    const unreachable = () => vi.fn().mockRejectedValue(new Error('background unreachable'));
    const selection = selectionShown();
    vi.mocked(useAppDispatch).mockReturnValue(selection.dispatch as unknown as ReturnType<typeof useAppDispatch>);
    const wallet = {
      removeKeyring: vi.fn().mockResolvedValue(undefined),
      ...afterRemoval(listed, selected === 'unread' ? unread.accounts[0] : null),
      ...(selected === 'fails' ? { getCurrentAccount: unreachable() } : {}),
      getCurrentKeyring: readBack === 'fails' ? unreachable() : vi.fn().mockResolvedValue(readBack === 'removed' ? keyring : null)
    };
    vi.mocked(useWallet).mockReturnValue(wallet as unknown as Wallet);

    render(
      <>
        <selection.Selection />
        <RemoveWalletPopover keyring={keyring as unknown as WalletKeyring} onClose={onClose} />
      </>
    );
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(selection.rendered.at(-1)).toBe('keyring_2 keyring_2#0'));
    expect(selection.mixed()).toEqual([]);
    expect(selection.dispatch).toHaveBeenCalledWith({ type: 'keyrings/setKeyrings', payload: listed });
    expect(selection.dispatch).toHaveBeenCalledWith({ type: 'keyrings/setCurrent', payload: last });
    // The background is asked first, and its answer followed when it names a wallet read.
    expect(wallet.getCurrentKeyring).toHaveBeenCalledTimes(readBack === 'not read' ? 0 : 1);
    expect(navigate).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('keeps the account shown when the last usable wallet read holds it and nothing says which is current', async () => {
    const accounts = [0, 1].map((index) => ({
      ...account,
      address: `tq1qlast${index}`,
      key: `keyring_2#${index}`,
      index,
      pubkey: `last-${index}`
    }));
    const last = { ...walletInSlot(2), accounts };
    // Another wallet is removed while the second account of the last wallet is shown.
    vi.mocked(useCurrentAccount).mockReturnValue(accounts[1] as unknown as CurrentAccount);
    vi.mocked(useWallet).mockReturnValue({
      removeKeyring: vi.fn().mockResolvedValue(undefined),
      ...afterRemoval([nextKeyring, last], null),
      getCurrentAccount: vi.fn().mockRejectedValue(new Error('background unreachable'))
    } as unknown as Wallet);

    render(<RemoveWalletPopover keyring={keyring as unknown as WalletKeyring} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() =>
      expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
        { type: 'keyrings/setKeyrings', payload: [nextKeyring, last] },
        { type: 'keyrings/setCurrent', payload: last },
        { type: 'account/setCurrent', payload: accounts[1] }
      ])
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    ['no account reads as selected', 'none'],
    ['the account selected cannot be read', 'fails']
  ])(
    'goes to the welcome screen, not to a corrupted wallet, when no usable wallet is left and %s',
    async (_which, selected) => {
      const corrupted = { ...keyring, index: 0, key: 'keyring_0', accounts: [], isCorrupted: true };
      const wallet = {
        removeKeyring: vi.fn().mockResolvedValue(undefined),
        // With no usable wallet, the background has no account selected.
        ...afterRemoval([corrupted], null),
        ...(selected === 'fails'
          ? { getCurrentAccount: vi.fn().mockRejectedValue(new Error('background unreachable')) }
          : {})
      };
      vi.mocked(useWallet).mockReturnValue(wallet as unknown as ReturnType<typeof useWallet>);

      render(<RemoveWalletPopover keyring={keyring as unknown as WalletKeyring} onClose={onClose} />);
      fireEvent.click(screen.getByText('remove'));

      await waitFor(() => expect(navigate).toHaveBeenCalledWith('WelcomeScreen'));
      expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'keyrings/setCurrent' }));
      expect(toastError).not.toHaveBeenCalled();
    }
  );

  // The wallets read as none once a lock lands while the removal is saved,
  // although the vault still holds them.
  it.each([
    ['nothing', undefined],
    ['the wallet it had current', nextKeyring]
  ])(
    'asks for the password, and leaves the wallets in the store, when a lock lands while the removal is saved and the background returns %s',
    async (_which, returned) => {
      vi.mocked(useWallet).mockReturnValue({
        removeKeyring: vi.fn().mockResolvedValue(returned),
        getKeyrings: vi.fn().mockResolvedValue([]),
        getCurrentAccount: vi.fn().mockResolvedValue(null),
        isUnlocked: vi.fn().mockResolvedValue(false)
      } as unknown as Wallet);

      render(<RemoveWalletPopover keyring={keyring as unknown as WalletKeyring} onClose={onClose} />);
      fireEvent.click(screen.getByText('remove'));

      await waitFor(() => expect(navToLock).toHaveBeenCalledWith({ autoUnlockByFace: false }));
      expect(dispatch).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
      expect(toastError).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    }
  );

  it('does not report a refused removal when the post-removal refresh fails', async () => {
    vi.mocked(useWallet).mockReturnValue({
      removeKeyring: vi.fn().mockResolvedValue(nextKeyring),
      getKeyrings: vi.fn().mockRejectedValue(new Error('background unreachable'))
    } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: 'account/setCurrent', payload: nextAccount })
    );
    expect(dispatch).toHaveBeenCalledWith({ type: 'keyrings/setCurrent', payload: nextKeyring });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'keyrings/setKeyrings' })
    );
    expect(toastError).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('closes without dispatching when the refresh fails and no next keyring exists', async () => {
    vi.mocked(useWallet).mockReturnValue({
      removeKeyring: vi.fn().mockResolvedValue(undefined),
      getKeyrings: vi.fn().mockRejectedValue(new Error('background unreachable'))
    } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(dispatch).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  const ackRequiredError = {
    code: ErrorCodes.QBIT_RECOVERY_REMOVAL_ACK_REQUIRED,
    message: 'qbit_recovery_wallets_retained',
    data: {
      reasons: [{ role: 'destination', network: 'regtest', status: 'migrating', hasInflightPlans: true }]
    }
  };

  it('shows the recovery risk step instead of toasting when confirmation is required', async () => {
    const removeKeyring = vi.fn().mockRejectedValue(ackRequiredError);
    vi.mocked(useWallet).mockReturnValue({ removeKeyring, getKeyrings: vi.fn() } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_title')).toBeTruthy());
    expect(screen.getByText('qbit_recovery_removal_destination')).toBeTruthy();
    expect(screen.getByText('qbit_recovery_removal_inflight')).toBeTruthy();
    expect(removeKeyring).toHaveBeenCalledTimes(1);
    expect(removeKeyring).toHaveBeenCalledWith(keyring, undefined);
    expect(toastError).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('maps each reason onto its risk line and falls back when detail is missing', async () => {
    const removeKeyring = vi.fn().mockRejectedValue({
      ...ackRequiredError,
      data: {
        reasons: [
          { role: 'source', network: 'regtest', status: 'migrating' },
          { role: 'source', network: 'mainnet', status: 'migrated' }
        ]
      }
    });
    vi.mocked(useWallet).mockReturnValue({ removeKeyring, getKeyrings: vi.fn() } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_source_migrating')).toBeTruthy());
    expect(screen.getByText('qbit_recovery_removal_source_migrated')).toBeTruthy();
    expect(screen.queryByText('qbit_recovery_removal_destination')).toBeNull();

    cleanup();
    const detailFreeRemove = vi.fn().mockRejectedValue({ ...ackRequiredError, data: undefined });
    vi.mocked(useWallet).mockReturnValue({ removeKeyring: detailFreeRemove, getKeyrings: vi.fn() } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_unverified')).toBeTruthy());
  });

  it('sends the acknowledged removal only after the typed agreement', async () => {
    const removeKeyring = vi
      .fn()
      .mockRejectedValueOnce(ackRequiredError)
      .mockResolvedValueOnce(nextKeyring);
    vi.mocked(useWallet).mockReturnValue({
      removeKeyring,
      ...afterRemoval([nextKeyring], nextAccount)
    } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));
    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_title')).toBeTruthy());

    fireEvent.click(screen.getByTestId('recovery-removal-confirm-button'));
    expect(removeKeyring).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByTestId('recovery-removal-confirmation-input'), {
      target: { value: 'confirm' }
    });
    await waitFor(() =>
      expect(screen.getByTestId('recovery-removal-confirm-button').getAttribute('aria-disabled')).toBe('false')
    );
    fireEvent.click(screen.getByTestId('recovery-removal-confirm-button'));

    await waitFor(() => expect(removeKeyring).toHaveBeenCalledTimes(2));
    // The retry carries the displayed reason set so the background can spot
    // risks that appeared while the warning was open.
    expect(removeKeyring).toHaveBeenLastCalledWith(keyring, {
      acknowledgedQbitRecoveryRisks: true,
      acknowledgedQbitRecoveryReasons: ackRequiredError.data.reasons
    });
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: 'account/setCurrent', payload: nextAccount })
    );
    expect(dispatch).toHaveBeenCalledWith({ type: 'keyrings/setKeyrings', payload: [nextKeyring] });
    expect(toastError).not.toHaveBeenCalled();
  });

  it('re-prompts with the refreshed reasons when the acknowledged removal is refused again', async () => {
    const removeKeyring = vi
      .fn()
      .mockRejectedValueOnce(ackRequiredError)
      .mockRejectedValueOnce({
        ...ackRequiredError,
        data: {
          reasons: [{ role: 'source', network: 'regtest', status: 'migrating', hasInflightPlans: true }]
        }
      });
    vi.mocked(useWallet).mockReturnValue({ removeKeyring, getKeyrings: vi.fn() } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));
    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_destination')).toBeTruthy());

    fireEvent.change(screen.getByTestId('recovery-removal-confirmation-input'), {
      target: { value: 'CONFIRM' }
    });
    fireEvent.click(screen.getByTestId('recovery-removal-confirm-button'));

    // The risks changed while the warning was open: the popover shows the
    // refreshed lines and demands a fresh typed confirmation instead of
    // closing over the new risk.
    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_source_migrating')).toBeTruthy());
    expect(removeKeyring).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(screen.getByTestId('recovery-removal-confirm-button').getAttribute('aria-disabled')).toBe('true');
  });

  it('cancels the risk step without retrying the removal', async () => {
    const removeKeyring = vi.fn().mockRejectedValue(ackRequiredError);
    vi.mocked(useWallet).mockReturnValue({ removeKeyring, getKeyrings: vi.fn() } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));
    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_title')).toBeTruthy());

    fireEvent.click(screen.getByText('cancel'));
    expect(onClose).toHaveBeenCalled();
    expect(removeKeyring).toHaveBeenCalledTimes(1);
  });

  it('sends a single removal no matter how fast remove is clicked twice', async () => {
    let resolveRemoval: (value: unknown) => void = () => undefined;
    const removeKeyring = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveRemoval = resolve)));
    vi.mocked(useWallet).mockReturnValue({
      removeKeyring,
      ...afterRemoval([], null)
    } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));
    fireEvent.click(screen.getByText('remove'));
    expect(removeKeyring).toHaveBeenCalledTimes(1);

    resolveRemoval(undefined);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('WelcomeScreen'));
    expect(removeKeyring).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('ignores a second confirm click while the acknowledged removal is in flight', async () => {
    let resolveRemoval: (value: unknown) => void = () => undefined;
    const removeKeyring = vi
      .fn()
      .mockRejectedValueOnce(ackRequiredError)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveRemoval = resolve)));
    vi.mocked(useWallet).mockReturnValue({
      removeKeyring,
      ...afterRemoval([nextKeyring], nextAccount)
    } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));
    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_title')).toBeTruthy());

    fireEvent.change(screen.getByTestId('recovery-removal-confirmation-input'), {
      target: { value: 'CONFIRM' }
    });
    fireEvent.click(screen.getByTestId('recovery-removal-confirm-button'));
    fireEvent.click(screen.getByTestId('recovery-removal-confirm-button'));
    // One unacknowledged probe plus exactly one acknowledged removal.
    expect(removeKeyring).toHaveBeenCalledTimes(2);

    resolveRemoval(nextKeyring);
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: 'keyrings/setKeyrings', payload: [nextKeyring] })
    );
    expect(removeKeyring).toHaveBeenCalledTimes(2);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('keeps cancel inert while the acknowledged removal is in flight', async () => {
    let resolveRemoval: (value: unknown) => void = () => undefined;
    const removeKeyring = vi
      .fn()
      .mockRejectedValueOnce(ackRequiredError)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveRemoval = resolve)));
    vi.mocked(useWallet).mockReturnValue({
      removeKeyring,
      ...afterRemoval([nextKeyring], nextAccount)
    } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));
    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_title')).toBeTruthy());

    fireEvent.change(screen.getByTestId('recovery-removal-confirmation-input'), {
      target: { value: 'CONFIRM' }
    });
    fireEvent.click(screen.getByTestId('recovery-removal-confirm-button'));
    fireEvent.click(screen.getByTestId('recovery-removal-cancel-button'));
    expect(onClose).not.toHaveBeenCalled();

    resolveRemoval(nextKeyring);
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: 'account/setCurrent', payload: nextAccount })
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('toasts and closes when the acknowledged removal itself fails', async () => {
    const removeKeyring = vi
      .fn()
      .mockRejectedValueOnce(ackRequiredError)
      .mockRejectedValueOnce({ message: 'vault sealed' });
    vi.mocked(useWallet).mockReturnValue({ removeKeyring, getKeyrings: vi.fn() } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));
    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_title')).toBeTruthy());

    fireEvent.change(screen.getByTestId('recovery-removal-confirmation-input'), {
      target: { value: 'CONFIRM' }
    });
    fireEvent.click(screen.getByTestId('recovery-removal-confirm-button'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('vault sealed'));
    expect(onClose).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
