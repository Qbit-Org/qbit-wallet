import type { ChangeEventHandler, CSSProperties, KeyboardEventHandler, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCurrentKeyring, useI18n, useSetCurrentAccountCallback, useTools, useWallet } from '@qbit/wallet-state';
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
    onKeyUp,
    'data-testid': dataTestId
  }: {
    placeholder?: string;
    onChange?: ChangeEventHandler<HTMLInputElement>;
    onKeyUp?: KeyboardEventHandler<HTMLInputElement>;
    'data-testid'?: string;
  }) => React.createElement('input', { placeholder, onChange, onKeyUp, 'data-testid': dataTestId });

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

vi.mock('@qbit/wallet-shared', () => ({
  MAX_ALIAS_NAME_LENGTH: 20
}));

vi.mock('@qbit/wallet-state', () => ({
  useCurrentKeyring: vi.fn(),
  useI18n: vi.fn(),
  useSetCurrentAccountCallback: vi.fn(),
  useTools: vi.fn(),
  useWallet: vi.fn()
}));

describe('CreateAccountScreen', () => {
  const deriveNewAccountFromMnemonic = vi.fn();
  const getCurrentAccount = vi.fn();
  const getNextAlianName = vi.fn();
  const setCurrentAccount = vi.fn();
  const toastSuccess = vi.fn();
  const toastError = vi.fn();
  const toastWarning = vi.fn();
  const keyring = { index: 0 };

  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentAccount.mockResolvedValue({ address: 'qbit1current' });
    getNextAlianName.mockResolvedValue('Account 2');
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useTools).mockReturnValue({ toastSuccess, toastError, toastWarning } as any);
    vi.mocked(useWallet).mockReturnValue({
      deriveNewAccountFromMnemonic,
      getCurrentAccount,
      getNextAlianName
    } as any);
    vi.mocked(useSetCurrentAccountCallback).mockReturnValue(setCurrentAccount);
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
    expect(setCurrentAccount).toHaveBeenCalledWith({ address: 'qbit1current' });
    expect(navigateMock).toHaveBeenCalledWith('MainScreen');
  });

  it('ignores Enter presses while a creation is already in flight', async () => {
    deriveNewAccountFromMnemonic.mockReturnValue(new Promise(() => undefined));
    await renderScreen();

    const input = screen.getByTestId('create-account-name-input');
    fireEvent.keyUp(input, { key: 'Enter' });
    fireEvent.keyUp(input, { key: 'Enter' });
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
    getCurrentAccount.mockResolvedValue({ address: 'qbit1new' });
    await renderScreen();

    fireEvent.click(screen.getByTestId('create-account-confirm-button'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(toastWarning).toHaveBeenCalledWith('qbit_restore_floors_incomplete_warning');
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(setCurrentAccount).toHaveBeenCalledWith({ address: 'qbit1new' });
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
    getCurrentAccount.mockResolvedValue({ address: 'qbit1new' });
    await renderScreen();

    fireEvent.click(screen.getByTestId('create-account-confirm-button'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(toastError).toHaveBeenCalledWith('floor scan failed');
    expect(toastSuccess).not.toHaveBeenCalled();
    // The (possibly) committed account is synced and the screen is left.
    expect(setCurrentAccount).toHaveBeenCalledWith({ address: 'qbit1new' });
    expect(navigateMock).toHaveBeenCalledWith('MainScreen');
    const button = screen.getByTestId('create-account-confirm-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(deriveNewAccountFromMnemonic).toHaveBeenCalledTimes(1);
  });

  it('leaves the screen without re-arming when the account sync fails after a failed creation', async () => {
    deriveNewAccountFromMnemonic.mockRejectedValueOnce({ message: 'floor scan failed' });
    getCurrentAccount.mockRejectedValueOnce({ message: 'port closed' });
    await renderScreen();

    fireEvent.click(screen.getByTestId('create-account-confirm-button'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(toastError).toHaveBeenCalledWith('floor scan failed');
    expect(setCurrentAccount).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith('MainScreen');
    const button = screen.getByTestId('create-account-confirm-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(deriveNewAccountFromMnemonic).toHaveBeenCalledTimes(1);
  });

  it('does not re-arm the create action when the account sync fails after a successful creation', async () => {
    deriveNewAccountFromMnemonic.mockResolvedValueOnce(undefined);
    getCurrentAccount.mockRejectedValueOnce({ message: 'port closed' });
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
});
