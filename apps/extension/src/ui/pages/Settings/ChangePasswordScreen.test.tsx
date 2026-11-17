import type { ChangeEventHandler, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import ChangePasswordScreen from './ChangePasswordScreen';

const routerNavigate = vi.hoisted(() => ({ calls: [] as unknown[][] }));
const walletState = vi.hoisted(() => ({
  changePasswordKeepingBiometric: vi.fn(),
  navigate: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}));

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children);
  return {
    Button: ({
      text,
      onClick,
      disabled,
      'data-testid': dataTestId
    }: {
      text?: string;
      onClick?: () => void;
      disabled?: boolean;
      'data-testid'?: string;
    }) => React.createElement('button', { onClick, disabled, 'data-testid': dataTestId }, text),
    Column: Container,
    Content: Container,
    Header: ({ onBack }: { onBack?: () => void }) => React.createElement('button', { onClick: onBack }, 'back'),
    Input: ({
      onChange,
      'data-testid': dataTestId
    }: {
      onChange?: ChangeEventHandler<HTMLInputElement>;
      'data-testid'?: string;
    }) => React.createElement('input', { onChange, 'data-testid': dataTestId }),
    Layout: Container,
    Row: Container,
    Text: ({ text }: { text?: string }) => React.createElement('span', null, text)
  };
});

vi.mock('react-router-dom', () => ({
  useNavigate:
    () =>
    (...args: unknown[]) =>
      routerNavigate.calls.push(args)
}));

// The route table would load every screen.
vi.mock('../MainRoute', () => ({ useNavigate: () => walletState.navigate }));

vi.mock('@qbit/wallet-state', () => ({
  useBiometricUnlock: () => ({ changePasswordKeepingBiometric: walletState.changePasswordKeepingBiometric }),
  useI18n: () => ({ t: (key: string) => key }),
  useTools: () => ({ toastError: walletState.toastError, toastSuccess: walletState.toastSuccess })
}));

describe('ChangePasswordScreen Back', () => {
  let go: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    routerNavigate.calls = [];
    go = vi.spyOn(window.history, 'go').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    go.mockRestore();
    window.history.replaceState(null, '', '#/');
  });

  it('rebuilds Settings → Security when the screen is the first history entry', () => {
    window.history.replaceState({ idx: 0 }, '', '#/settings/password');
    render(<ChangePasswordScreen />);

    fireEvent.click(screen.getByText('back'));

    // Settings replaces this entry and Security is pushed on it, so this Back
    // lands on Security and Security's own Back on Settings.
    expect(routerNavigate.calls).toEqual([['/settings', { replace: true }], ['/settings/security']]);
    expect(go).not.toHaveBeenCalled();
  });

  it('goes back in history when there is a screen behind it', () => {
    window.history.replaceState({ idx: 3 }, '', '#/settings/password');
    render(<ChangePasswordScreen />);

    fireEvent.click(screen.getByText('back'));

    expect(go).toHaveBeenCalledWith(-1);
    expect(routerNavigate.calls).toEqual([]);
  });
});

// Rejections reach the page as plain objects, not Errors: the toast shows
// their message, or unknown_error, and never "undefined" or nothing.
describe.each([
  ['a plain rejection with a message', { code: -32603, message: 'Password is incorrect' }, 'Password is incorrect'],
  ['a plain rejection without a message', { code: -32603 }, 'unknown_error']
])('ChangePasswordScreen, %s', (_name, rejection, shown) => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows it when the password change is refused', async () => {
    walletState.changePasswordKeepingBiometric.mockRejectedValue(rejection);
    render(<ChangePasswordScreen />);
    fireEvent.change(screen.getByTestId('current-password-input'), { target: { value: 'old-password' } });
    fireEvent.change(screen.getByTestId('new-password-input'), { target: { value: 'New-password-42' } });
    fireEvent.change(screen.getByTestId('confirm-password-input'), { target: { value: 'New-password-42' } });

    fireEvent.click(screen.getByTestId('change-password-confirm-button'));

    await waitFor(() => expect(walletState.toastError).toHaveBeenCalled());
    expect(walletState.changePasswordKeepingBiometric).toHaveBeenCalledWith('old-password', 'New-password-42');
    expect(walletState.toastError.mock.calls.map(([text]) => text)).toEqual([shown]);
    expect(walletState.toastSuccess).not.toHaveBeenCalled();
    expect(walletState.navigate).not.toHaveBeenCalled();
  });
});
