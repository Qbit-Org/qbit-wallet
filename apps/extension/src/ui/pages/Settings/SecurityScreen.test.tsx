import type { CSSProperties, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { colors } from '@/ui/theme/colors';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { KeyringType } from '@qbit/wallet-shared';

import SecurityScreen from './SecurityScreen';

const harness = vi.hoisted(
  () => ({}) as { navigate: Mock; routerNavigate: Mock; currentKeyring: { key: string; type: string } }
);

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({
    children,
    onClick,
    'data-testid': testId
  }: {
    children?: ReactNode;
    onClick?: () => void;
    'data-testid'?: string;
  }) => React.createElement('div', { onClick, 'data-testid': testId }, children);
  return {
    Card: Container,
    Column: Container,
    Content: Container,
    Layout: Container,
    Row: Container,
    Header: ({ title, onBack }: { title?: string; onBack?: () => void }) =>
      React.createElement('header', null, React.createElement('button', { onClick: onBack }, 'back'), title),
    Icon: ({ icon, color }: { icon?: string; color?: string }) =>
      React.createElement('i', { 'data-icon': icon, 'data-color': color }),
    Text: ({ text, style }: { text?: string; style?: CSSProperties }) => React.createElement('span', { style }, text)
  };
});

// The dialog has its own tests; here it only has to open and close.
vi.mock('@/ui/components/ResetWalletPopover', async () => {
  const React = await import('react');
  return {
    ResetWalletPopover: ({
      lastWalletKey,
      outdated,
      onClose
    }: {
      lastWalletKey?: string;
      outdated?: boolean;
      onClose: () => void;
    }) =>
      React.createElement(
        'div',
        {
          'data-testid': 'reset-wallet-dialog',
          'data-last-wallet-key': String(lastWalletKey ?? ''),
          'data-outdated': String(outdated === true)
        },
        React.createElement('button', { onClick: onClose }, 'close-reset')
      )
  };
});

vi.mock('react-router-dom', () => ({ useNavigate: () => harness.routerNavigate }));

vi.mock('@qbit/wallet-state', () => ({
  useCurrentKeyring: () => harness.currentKeyring,
  useI18n: () => ({ t: (key: string) => key }),
  useNavigation: () => ({ navigate: harness.navigate })
}));

const rowIds = () => screen.getAllByTestId(/^security_/).map((row) => row.getAttribute('data-testid'));
const labelOf = (id: string) => screen.getByTestId(id).querySelector('span') as HTMLElement;
const iconOf = (id: string) => screen.getByTestId(id).querySelector('i') as HTMLElement;

describe('SecurityScreen', () => {
  beforeEach(() => {
    harness.navigate = vi.fn();
    harness.routerNavigate = vi.fn();
    harness.currentKeyring = { key: 'keyring_0', type: KeyringType.QbitHdKeyring };
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState(null, '', '#/');
  });

  it('offers exactly Change Password, Show Secret Recovery Phrase and Reset Wallet, in that order', () => {
    render(<SecurityScreen />);

    expect(screen.getByText('security')).toBeTruthy();
    expect(rowIds()).toEqual(['security_changePassword', 'security_showSeedPhrase', 'security_resetWallet']);
    expect(labelOf('security_changePassword').textContent).toBe('change_password');
    expect(labelOf('security_showSeedPhrase').textContent).toBe('show_secret_recovery_phrase');
    expect(labelOf('security_resetWallet').textContent).toBe('reset_wallet');
  });

  it('opens Change Password', () => {
    render(<SecurityScreen />);

    fireEvent.click(screen.getByTestId('security_changePassword'));

    expect(harness.navigate).toHaveBeenCalledWith('ChangePasswordScreen');
  });

  it.each([KeyringType.HdKeyring, KeyringType.QbitHdKeyring])(
    'shows the recovery phrase of the current %s wallet, as the switcher does',
    (type) => {
      harness.currentKeyring = { key: 'keyring_3', type };
      render(<SecurityScreen />);

      fireEvent.click(screen.getByTestId('security_showSeedPhrase'));

      expect(harness.navigate).toHaveBeenCalledWith('ExportMnemonicsScreen', { keyring: harness.currentKeyring });
    }
  );

  it.each([
    KeyringType.SimpleKeyring,
    KeyringType.ReadonlyKeyring,
    KeyringType.WatchAddressKeyring,
    KeyringType.ColdWalletKeyring,
    'Other Key Type',
    // No wallet in the store.
    ''
  ])('offers no recovery phrase for a %s wallet, which has none', (type) => {
    harness.currentKeyring = { key: 'keyring_1', type };
    render(<SecurityScreen />);

    expect(rowIds()).toEqual(['security_changePassword', 'security_resetWallet']);
  });

  it('shows Reset Wallet in red and opens the reset dialog', () => {
    render(<SecurityScreen />);

    expect(labelOf('security_resetWallet').style.color).toBe(colors.dangerText);
    expect(iconOf('security_resetWallet').getAttribute('data-color')).toBe('dangerText');
    expect(labelOf('security_changePassword').style.color).toBe(colors.text);
    expect(screen.queryByTestId('reset-wallet-dialog')).toBeNull();

    fireEvent.click(screen.getByTestId('security_resetWallet'));

    // The Settings entry, not the last-wallet one from the switcher.
    expect(screen.getByTestId('reset-wallet-dialog').getAttribute('data-last-wallet-key')).toBe('');
    expect(harness.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('close-reset'));
    expect(screen.queryByTestId('reset-wallet-dialog')).toBeNull();
  });

  // Opened from Settings, a reset rests on no premise about the wallets.
  it('keeps the reset dialog open, never outdated, whatever the current wallet becomes', () => {
    const { rerender } = render(<SecurityScreen />);
    fireEvent.click(screen.getByTestId('security_resetWallet'));

    for (const keyring of [
      { key: 'keyring_4', type: KeyringType.SimpleKeyring },
      { key: '', type: '' },
      { key: 'keyring_5', type: KeyringType.HdKeyring }
    ]) {
      harness.currentKeyring = keyring;
      rerender(<SecurityScreen />);
      expect(screen.getByTestId('reset-wallet-dialog').getAttribute('data-outdated')).toBe('false');
    }
  });

  it('goes back to Settings when it is the first history entry', () => {
    window.history.replaceState({ idx: 0 }, '', '#/settings/security');
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => undefined);
    render(<SecurityScreen />);

    fireEvent.click(screen.getByText('back'));

    expect(harness.routerNavigate).toHaveBeenCalledWith('/settings', { replace: true });
    expect(go).not.toHaveBeenCalled();

    window.history.replaceState({ idx: 2 }, '', '#/settings/security');
    fireEvent.click(screen.getByText('back'));
    expect(go).toHaveBeenCalledWith(-1);
    expect(harness.routerNavigate).toHaveBeenCalledTimes(1);
    go.mockRestore();
  });
});
