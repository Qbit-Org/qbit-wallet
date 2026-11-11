import type { ChangeEventHandler, CSSProperties, KeyboardEventHandler, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useCurrentKeyring,
  useI18n,
  useKeyrings,
  useNavigation,
  useReloadAccounts,
  useTools,
  useWallet
} from '@qbit/wallet-state';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import CreateAccountScreen from './CreateAccountScreen';

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({
    children,
    style,
    'data-testid': dataTestId
  }: {
    children?: ReactNode;
    style?: CSSProperties;
    'data-testid'?: string;
  }) => React.createElement('div', { style, 'data-testid': dataTestId }, children);
  // Mirrors the real Button's loading semantics (covered by Button.test.tsx):
  // loading behaves as disabled and drops onClick.
  const Button = ({
    text,
    onClick,
    disabled,
    loading,
    'data-testid': dataTestId
  }: {
    text?: string;
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
    'data-testid'?: string;
  }) =>
    React.createElement(
      'button',
      {
        onClick: disabled || loading ? undefined : onClick,
        disabled: disabled || loading,
        'data-testid': dataTestId
      },
      text
    );
  const Input = ({
    placeholder,
    onChange,
    onKeyDown,
    onKeyUp,
    'aria-describedby': describedBy,
    'data-testid': dataTestId
  }: {
    placeholder?: string;
    onChange?: ChangeEventHandler<HTMLInputElement>;
    onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
    onKeyUp?: KeyboardEventHandler<HTMLInputElement>;
    'aria-describedby'?: string;
    'data-testid'?: string;
  }) =>
    React.createElement('input', {
      placeholder,
      onChange,
      onKeyDown,
      onKeyUp,
      'aria-describedby': describedBy,
      'data-testid': dataTestId
    });

  return {
    Button,
    Column: Container,
    Content: Container,
    Header: Container,
    Input,
    Layout: Container
  };
});

const navigateMock = vi.fn();
vi.mock('@/ui/pages/MainRoute', () => ({
  useNavigate: () => navigateMock
}));

vi.mock('@/ui/utils', () => ({
  walletErrorMessage: (error: unknown, fallback: string) => {
    if (typeof error === 'string' && error) return error;
    const message = (error as { message?: unknown } | null | undefined)?.message;
    return typeof message === 'string' && message ? message : fallback;
  }
}));

vi.mock('@qbit/wallet-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qbit/wallet-shared')>()),
  MAX_ALIAS_NAME_LENGTH: 20
}));

vi.mock('@qbit/wallet-state', async () => {
  // The package's own rule for an Enter pressed in a field. The package index
  // needs import paths only the package's own setup resolves, so the module
  // that holds the rule is imported alone.
  const { isEnterPressedInField } = await import(
    '../../../../../../packages/wallet-state/src/ui-hooks/isEnterPressedInField'
  );
  return {
    isEnterPressedInField,
    useCurrentKeyring: vi.fn(),
    useI18n: vi.fn(),
    useKeyrings: vi.fn(),
    useNavigation: vi.fn(),
    useReloadAccounts: vi.fn(),
    useTools: vi.fn(),
    useWallet: vi.fn()
  };
});

describe('CreateAccountScreen', () => {
  const deriveNewAccountFromMnemonic = vi.fn();
  const getKeyrings = vi.fn();
  const getNextAlianName = vi.fn();
  const reloadAccounts = vi.fn();
  const toastSuccess = vi.fn();
  const toastError = vi.fn();
  const toastWarning = vi.fn();
  const keyring = { index: 0, key: 'keyring_0', alianName: 'Wallet 1', color: 'green' };
  const otherKeyring = { index: 2, key: 'keyring_2', alianName: 'Long-term savings', color: 'pink' };
  let routeState: { keyringKey?: string } = {};

  beforeEach(() => {
    vi.clearAllMocks();
    routeState = {};
    reloadAccounts.mockResolvedValue(undefined);
    getNextAlianName.mockResolvedValue('Account 2');
    getKeyrings.mockResolvedValue([keyring, otherKeyring]);
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useTools).mockReturnValue({ toastSuccess, toastError, toastWarning } as any);
    vi.mocked(useWallet).mockReturnValue({
      deriveNewAccountFromMnemonic,
      getKeyrings,
      getNextAlianName
    } as any);
    vi.mocked(useReloadAccounts).mockReturnValue(reloadAccounts);
    vi.mocked(useNavigation).mockReturnValue({ getRouteState: () => routeState } as never);
    vi.mocked(useKeyrings).mockReturnValue([keyring, otherKeyring] as never);
    vi.mocked(useCurrentKeyring).mockReturnValue(keyring as any);
  });

  afterEach(() => {
    cleanup();
  });

  async function renderScreen() {
    render(<CreateAccountScreen />);
    // Flush the init effect that resolves the default account name.
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('creates exactly one account when the confirm button is clicked repeatedly', async () => {
    let resolveDerive!: () => void;
    deriveNewAccountFromMnemonic.mockReturnValue(
      new Promise<{ floorScanPending: boolean }>((resolve) => {
        resolveDerive = () => resolve({ floorScanPending: false });
      })
    );
    await renderScreen();

    fireEvent.click(screen.getByTestId('create-account-confirm-button'));
    expect(deriveNewAccountFromMnemonic).toHaveBeenCalledTimes(1);
    expect(deriveNewAccountFromMnemonic).toHaveBeenCalledWith(keyring, 'Account 2');

    // On a mnemonic-restored wallet the derive RPC can take many seconds;
    // the button must be disabled and further clicks no-ops meanwhile.
    const inFlightButton = screen.getByTestId('create-account-confirm-button') as HTMLButtonElement;
    expect(inFlightButton.disabled).toBe(true);
    fireEvent.click(inFlightButton);
    fireEvent.click(inFlightButton);
    expect(deriveNewAccountFromMnemonic).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDerive();
    });
    expect(toastSuccess).toHaveBeenCalledWith('success');
    // The derive selected the account; the store reads it back from the background.
    expect(reloadAccounts).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('MainScreen');
  });

  /** One press of Enter in `element`, as a key goes down and comes up. */
  function pressEnter(element: HTMLElement) {
    fireEvent.keyDown(element, { key: 'Enter' });
    fireEvent.keyUp(element, { key: 'Enter' });
  }

  it('ignores Enter presses while a creation is already in flight', async () => {
    deriveNewAccountFromMnemonic.mockReturnValue(new Promise(() => undefined));
    await renderScreen();

    const input = screen.getByTestId('create-account-name-input');
    pressEnter(input);
    pressEnter(input);
    expect(deriveNewAccountFromMnemonic).toHaveBeenCalledTimes(1);
  });

  it('creates the account with the typed name on an Enter pressed in the name field', async () => {
    deriveNewAccountFromMnemonic.mockResolvedValueOnce({ floorScanPending: false });
    await renderScreen();

    const input = screen.getByTestId('create-account-name-input');
    fireEvent.change(input, { target: { value: 'Travel' } });
    pressEnter(input);
    await act(async () => {
      await Promise.resolve();
    });

    expect(deriveNewAccountFromMnemonic).toHaveBeenCalledTimes(1);
    expect(deriveNewAccountFromMnemonic).toHaveBeenCalledWith(keyring, 'Travel');
    expect(navigateMock).toHaveBeenCalledWith('MainScreen');
  });

  it('creates nothing when the Enter that opened the screen comes up in the name field', async () => {
    // The switcher's "+" and Add account act on the keydown of an Enter; the
    // field has focus by the time that key comes up.
    await renderScreen();

    fireEvent.keyUp(screen.getByTestId('create-account-name-input'), { key: 'Enter' });
    await act(async () => {
      await Promise.resolve();
    });

    expect(deriveNewAccountFromMnemonic).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('creates nothing while an Enter held down since before the screen opened repeats', async () => {
    await renderScreen();

    const input = screen.getByTestId('create-account-name-input');
    for (let repeat = 0; repeat < 3; repeat++) {
      fireEvent.keyDown(input, { key: 'Enter', repeat: true });
    }
    fireEvent.keyUp(input, { key: 'Enter' });
    await act(async () => {
      await Promise.resolve();
    });

    expect(deriveNewAccountFromMnemonic).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('creates one account for an Enter held down in the name field', async () => {
    deriveNewAccountFromMnemonic.mockResolvedValue({ floorScanPending: false });
    await renderScreen();

    const input = screen.getByTestId('create-account-name-input');
    fireEvent.keyDown(input, { key: 'Enter' });
    for (let repeat = 0; repeat < 3; repeat++) {
      fireEvent.keyDown(input, { key: 'Enter', repeat: true });
    }
    fireEvent.keyUp(input, { key: 'Enter' });
    await act(async () => {
      await Promise.resolve();
    });

    expect(deriveNewAccountFromMnemonic).toHaveBeenCalledTimes(1);
  });

  it('creates nothing on an Enter pressed anywhere but the name field', async () => {
    routeState = { keyringKey: 'keyring_2' };
    await renderScreen();

    // The wallet the account goes to, shown above the field.
    pressEnter(screen.getByTestId('create-account-wallet-name'));
    pressEnter(screen.getByTestId('create-account-wallet-tile'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(deriveNewAccountFromMnemonic).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('creates nothing on the Enter that ends a composition, only on the next press', async () => {
    deriveNewAccountFromMnemonic.mockResolvedValueOnce({ floorScanPending: false });
    await renderScreen();

    // An input method takes this Enter to commit the typed text.
    const input = screen.getByTestId('create-account-name-input');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyUp(input, { key: 'Enter' });
    expect(deriveNewAccountFromMnemonic).not.toHaveBeenCalled();

    pressEnter(input);
    await act(async () => {
      await Promise.resolve();
    });
    expect(deriveNewAccountFromMnemonic).toHaveBeenCalledTimes(1);
  });

  it('reports a created account whose floor scan is still pending with the translated warning', async () => {
    // A restored keyring commits the account before its in-band floor scan;
    // when that scan does not complete the RPC now resolves with the signing
    // gate still closed instead of rejecting with raw backend text (#228).
    deriveNewAccountFromMnemonic.mockResolvedValueOnce({
      floorScanPending: true,
      floorScanError: 'qbit address history changed while scanning qb1x'
    });
    await renderScreen();

    fireEvent.click(screen.getByTestId('create-account-confirm-button'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(toastWarning).toHaveBeenCalledWith('qbit_restore_floors_incomplete_warning');
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(reloadAccounts).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('MainScreen');
    const button = screen.getByTestId('create-account-confirm-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('leaves the screen without re-arming the button when creation fails', async () => {
    // A restored keyring commits and activates the account before the floor
    // scan, so a failure can reject with the account already created — and a
    // request rejected by a port drop may still commit in the background.
    // No retry is offered on this screen: it would derive a duplicate.
    // Background errors cross the port as plain { message } objects.
    deriveNewAccountFromMnemonic.mockRejectedValueOnce({ message: 'floor scan failed' });
    await renderScreen();

    fireEvent.click(screen.getByTestId('create-account-confirm-button'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(toastError).toHaveBeenCalledWith('floor scan failed');
    expect(toastSuccess).not.toHaveBeenCalled();
    // The (possibly) committed account is synced and the screen is left.
    expect(reloadAccounts).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('MainScreen');
    const button = screen.getByTestId('create-account-confirm-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(deriveNewAccountFromMnemonic).toHaveBeenCalledTimes(1);
  });

  it('leaves the screen without re-arming when the account sync fails after a failed creation', async () => {
    deriveNewAccountFromMnemonic.mockRejectedValueOnce({ message: 'floor scan failed' });
    reloadAccounts.mockRejectedValueOnce({ message: 'port closed' });
    await renderScreen();

    fireEvent.click(screen.getByTestId('create-account-confirm-button'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(toastError).toHaveBeenCalledWith('floor scan failed');
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('MainScreen');
    const button = screen.getByTestId('create-account-confirm-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(deriveNewAccountFromMnemonic).toHaveBeenCalledTimes(1);
  });

  it('does not re-arm the create action when the account sync fails after a successful creation', async () => {
    deriveNewAccountFromMnemonic.mockResolvedValueOnce(undefined);
    reloadAccounts.mockRejectedValueOnce({ message: 'port closed' });
    await renderScreen();

    fireEvent.click(screen.getByTestId('create-account-confirm-button'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(toastSuccess).toHaveBeenCalledWith('success');
    expect(toastError).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith('MainScreen');
    const button = screen.getByTestId('create-account-confirm-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(deriveNewAccountFromMnemonic).toHaveBeenCalledTimes(1);
  });
  it('names the wallet the account goes to, with its tile, above the name field', async () => {
    routeState = { keyringKey: 'keyring_2' };
    await renderScreen();

    const walletName = screen.getByTestId('create-account-wallet-name');
    const nameField = screen.getByTestId('create-account-name-input');
    expect(walletName.textContent).toBe('Long-term savings');
    expect(screen.getByTestId('create-account-wallet-tile').getAttribute('data-color')).toBe('pink');
    expect(walletName.compareDocumentPosition(nameField) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The field takes focus first, so it carries the wallet's name too.
    expect(nameField.getAttribute('aria-describedby')).toBe(walletName.id);
  });

  it('names the current wallet when the switcher named none', async () => {
    await renderScreen();

    expect(screen.getByTestId('create-account-wallet-name').textContent).toBe('Wallet 1');
    expect(screen.getByTestId('create-account-wallet-tile').getAttribute('data-color')).toBe('green');
  });

  it('derives on the wallet the switcher named, not the current one', async () => {
    routeState = { keyringKey: 'keyring_2' };
    getNextAlianName.mockResolvedValue('Account 4');
    deriveNewAccountFromMnemonic.mockResolvedValueOnce({ floorScanPending: false });
    await renderScreen();

    expect(getNextAlianName).toHaveBeenCalledWith(otherKeyring);
    expect((screen.getByTestId('create-account-name-input') as HTMLInputElement).placeholder).toBe('Account 4');
    fireEvent.click(screen.getByTestId('create-account-confirm-button'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(deriveNewAccountFromMnemonic).toHaveBeenCalledTimes(1);
    expect(deriveNewAccountFromMnemonic).toHaveBeenCalledWith(otherKeyring, 'Account 4');
    expect(reloadAccounts).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('MainScreen');
  });

  it('passes the typed name for the named wallet', async () => {
    routeState = { keyringKey: 'keyring_2' };
    deriveNewAccountFromMnemonic.mockResolvedValueOnce({ floorScanPending: false });
    await renderScreen();

    fireEvent.change(screen.getByTestId('create-account-name-input'), { target: { value: 'Savings' } });
    fireEvent.click(screen.getByTestId('create-account-confirm-button'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(deriveNewAccountFromMnemonic).toHaveBeenCalledWith(otherKeyring, 'Savings');
  });

  it('reads a named wallet the store does not list yet from the background', async () => {
    routeState = { keyringKey: 'keyring_2' };
    vi.mocked(useKeyrings).mockReturnValue([keyring] as never);
    deriveNewAccountFromMnemonic.mockResolvedValueOnce({ floorScanPending: false });
    await renderScreen();

    fireEvent.click(screen.getByTestId('create-account-confirm-button'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(getKeyrings).toHaveBeenCalledTimes(1);
    expect(deriveNewAccountFromMnemonic).toHaveBeenCalledWith(otherKeyring, '');
  });

  it('derives nothing, and never on another wallet, when the named wallet is gone', async () => {
    routeState = { keyringKey: 'keyring_7' };
    await renderScreen();

    fireEvent.click(screen.getByTestId('create-account-confirm-button'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(getNextAlianName).not.toHaveBeenCalled();
    expect(deriveNewAccountFromMnemonic).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('account_switcher_wallet_unavailable');
    expect(navigateMock).toHaveBeenCalledWith('MainScreen');
  });

  it('treats a failed read of the wallets like a missing wallet', async () => {
    routeState = { keyringKey: 'keyring_7' };
    getKeyrings.mockRejectedValueOnce({ message: 'port closed' });
    await renderScreen();

    fireEvent.click(screen.getByTestId('create-account-confirm-button'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(deriveNewAccountFromMnemonic).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('account_switcher_wallet_unavailable');
  });
});
