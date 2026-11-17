import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import BiometricUnlockScreen from './BiometricUnlockScreen';

const walletState = vi.hoisted(() => ({
  disable: vi.fn(),
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
    Header: ({ title }: { title?: string }) => React.createElement('header', null, title),
    Input: () => React.createElement('input'),
    Layout: Container,
    Text: ({ text }: { text?: string }) => React.createElement('span', null, text)
  };
});

vi.mock('@/ui/utils/settingsBack', () => ({ useBackToSettingsParent: () => vi.fn() }));

vi.mock('@qbit/wallet-state', () => ({
  BiometricCeremonyCancelledError: class extends Error {},
  BiometricEnrollmentIncompleteError: class extends Error {},
  BiometricPasswordInvalidError: class extends Error {},
  BiometricPrfUnsupportedError: class extends Error {},
  useBiometricUnlock: () => ({
    ready: true,
    supported: true,
    enrolled: true,
    enroll: vi.fn(),
    disable: walletState.disable
  }),
  useI18n: () => ({ t: (key: string) => key }),
  useTools: () => ({ toastError: walletState.toastError, toastSuccess: walletState.toastSuccess })
}));

// Rejections reach the page as plain objects, not Errors: the toast shows
// their message, or unknown_error, and never "undefined" or nothing.
describe.each([
  [
    'a plain rejection with a message',
    { code: -32603, message: 'Touch ID unlock could not be turned off' },
    'Touch ID unlock could not be turned off'
  ],
  ['a plain rejection without a message', { code: -32603 }, 'unknown_error']
])('BiometricUnlockScreen, %s', (_name, rejection, shown) => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows it when turning Touch ID unlock off is refused', async () => {
    walletState.disable.mockRejectedValue(rejection);
    render(<BiometricUnlockScreen />);

    fireEvent.click(screen.getByTestId('disable-touch-id-button'));

    await waitFor(() => expect(walletState.toastError).toHaveBeenCalled());
    expect(walletState.disable).toHaveBeenCalledTimes(1);
    expect(walletState.toastError.mock.calls.map(([text]) => text)).toEqual([shown]);
    expect(walletState.toastSuccess).not.toHaveBeenCalled();
  });
});
