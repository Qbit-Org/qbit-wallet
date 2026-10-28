import type { CSSProperties, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { useDeveloperMode, useI18n, useNavigation } from '@qbit/wallet-state';

import AddKeyringScreen from './AddKeyringScreen';

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({
    children,
    style,
    onClick,
    'data-testid': dataTestId
  }: {
    children?: ReactNode;
    style?: CSSProperties;
    onClick?: (e: unknown) => void;
    'data-testid'?: string;
  }) => React.createElement('div', { style, onClick, 'data-testid': dataTestId }, children);
  const Text = ({
    text,
    'data-testid': dataTestId
  }: {
    text?: string;
    'data-testid'?: string;
  }) => React.createElement('span', { 'data-testid': dataTestId }, text);
  const Header = ({ title }: { title?: string }) =>
    React.createElement('div', null, title);

  return {
    Card: Container,
    Column: Container,
    Content: Container,
    Header,
    Layout: Container,
    Text
  };
});

vi.mock('@qbit/wallet-state', () => ({
  useDeveloperMode: vi.fn(),
  useI18n: vi.fn(),
  useNavigation: vi.fn()
}));

describe('AddKeyringScreen hardware-wallet gating', () => {
  const navigate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useNavigation).mockReturnValue({ navigate, goBack: vi.fn() } as any);
    vi.mocked(useDeveloperMode).mockReturnValue(false);
  });

  it('renders no hardware- or cold-wallet section', () => {
    render(<AddKeyringScreen />);

    expect(screen.getByText('create_with_mnemonics_24words')).toBeTruthy();
    expect(screen.queryByTestId('hardware-wallet-unsupported-notice')).toBeNull();
    expect(screen.queryByText('hardware_wallet_not_supported')).toBeNull();
    expect(screen.queryByText('create_cold_wallet')).toBeNull();
    expect(screen.queryByText('cold_wallet')).toBeNull();
    expect(navigate).not.toHaveBeenCalledWith('CreateColdWalletScreen', expect.anything());
  });

  it('renders no hardware- or cold-wallet section in developer mode', () => {
    vi.mocked(useDeveloperMode).mockReturnValue(true);
    render(<AddKeyringScreen />);

    expect(screen.getByText('readonly_wallet')).toBeTruthy();
    expect(screen.queryByTestId('hardware-wallet-unsupported-notice')).toBeNull();
    expect(screen.queryByText('hardware_wallet_not_supported')).toBeNull();
    expect(screen.queryByText('create_cold_wallet')).toBeNull();
    expect(screen.queryByText('cold_wallet')).toBeNull();
  });
});
