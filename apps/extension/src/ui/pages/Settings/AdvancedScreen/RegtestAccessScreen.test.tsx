import type { CSSProperties, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRegtestAccessStatus } from '@/ui/utils/regtestAccess';
import { useI18n, useNavigation, useTools, useWallet } from '@qbit/wallet-state';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { RegtestAccessScreen } from './RegtestAccessScreen';

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
    onClick?: () => void;
    'data-testid'?: string;
  }) => React.createElement('div', { style, onClick, 'data-testid': dataTestId }, children);
  const Text = ({ text, 'data-testid': dataTestId }: { text?: string; 'data-testid'?: string }) =>
    React.createElement('span', { 'data-testid': dataTestId }, text);
  const Header = ({ title, onBack }: { title?: string; onBack?: () => void }) =>
    React.createElement(
      'div',
      null,
      React.createElement('button', { 'data-testid': 'header-back', onClick: onBack }, title)
    );
  const Icon = ({ icon }: { icon?: string }) => React.createElement('i', { 'data-testid': `icon-${icon}` });
  const Loading = () => React.createElement('i', { 'data-testid': 'loading' });
  return {
    Column: Container,
    Content: Container,
    Header,
    Icon,
    Layout: Container,
    Loading,
    OptionListCard: Container,
    Row: Container,
    Text
  };
});

vi.mock('../RegtestAccessModal', async () => {
  const React = await import('react');
  return {
    default: ({ onBack, onEnabled }: { onBack: () => void; onEnabled: (status: unknown) => void }) =>
      React.createElement(
        'div',
        { 'data-testid': 'regtest-access-modal' },
        React.createElement('button', { 'data-testid': 'modal-back', onClick: onBack }),
        React.createElement('button', {
          'data-testid': 'modal-enabled',
          onClick: () =>
            onEnabled({ state: 'available', gated: true, permission: true, acknowledged: true, supported: true })
        })
      )
  };
});

vi.mock('@/ui/utils/regtestAccess', () => ({
  useRegtestAccessStatus: vi.fn(),
  isRegtestLocked: (status: any) => !status || (status.gated && status.state === 'locked')
}));

vi.mock('@qbit/wallet-state', () => ({
  useI18n: vi.fn(),
  useNavigation: vi.fn(),
  useTools: vi.fn(),
  useWallet: vi.fn()
}));

const locked = { state: 'locked', gated: true, permission: false, acknowledged: false, supported: true };
const available = { state: 'available', gated: true, permission: true, acknowledged: true, supported: true };
const flush = () => act(async () => undefined);

const option = (name: 'enabled' | 'disabled') => screen.getByTestId(`regtest-access-option-${name}`);
const checkedOptions = () =>
  ['enabled', 'disabled'].filter((name) =>
    option(name as 'enabled' | 'disabled').querySelector('[data-testid="icon-checked"]')
  );

describe('RegtestAccessScreen', () => {
  const wallet = { disableRegtestAccess: vi.fn() };
  const tools = { toastError: vi.fn(), toastSuccess: vi.fn() };
  const nav = { goBack: vi.fn() };
  const refresh = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useTools).mockReturnValue(tools as any);
    vi.mocked(useWallet).mockReturnValue(wallet as any);
    vi.mocked(useNavigation).mockReturnValue(nav as any);
    refresh.mockResolvedValue(undefined);
  });

  it('lists Enabled and Disabled with the current state checked, and goes back from the header', async () => {
    vi.mocked(useRegtestAccessStatus).mockReturnValue({ status: locked as any, refresh });
    render(<RegtestAccessScreen />);
    await flush();

    expect(screen.getByText('local_regtest')).toBeTruthy();
    expect(option('enabled').textContent).toBe('enabled');
    expect(option('disabled').textContent).toContain('disabled');
    expect(checkedOptions()).toEqual(['disabled']);

    fireEvent.click(screen.getByTestId('header-back'));
    expect(nav.goBack).toHaveBeenCalled();
  });

  it('treats an unknown status as Disabled so a tap cannot race the first read', async () => {
    vi.mocked(useRegtestAccessStatus).mockReturnValue({ status: null, refresh });
    render(<RegtestAccessScreen />);
    await flush();
    expect(checkedOptions()).toEqual(['disabled']);
    fireEvent.click(option('enabled'));
    await flush();
    // Not gated (unknown) → nothing to do; no modal, no background call.
    expect(screen.queryByTestId('regtest-access-modal')).toBeNull();
    expect(wallet.disableRegtestAccess).not.toHaveBeenCalled();
  });

  it('choosing Enabled runs the explanation flow and does not switch networks', async () => {
    vi.mocked(useRegtestAccessStatus).mockReturnValue({ status: locked as any, refresh });
    render(<RegtestAccessScreen />);
    await flush();

    fireEvent.click(option('enabled'));
    await flush();
    expect(screen.getByTestId('regtest-access-modal')).toBeTruthy();

    fireEvent.click(screen.getByTestId('modal-back'));
    await flush();
    expect(screen.queryByTestId('regtest-access-modal')).toBeNull();
    expect(tools.toastSuccess).not.toHaveBeenCalled();

    fireEvent.click(option('enabled'));
    await flush();
    fireEvent.click(screen.getByTestId('modal-enabled'));
    await flush();
    expect(screen.queryByTestId('regtest-access-modal')).toBeNull();
    expect(tools.toastSuccess).toHaveBeenCalledWith('regtest_access_enabled');
    expect(refresh).toHaveBeenCalled();
    expect(wallet.disableRegtestAccess).not.toHaveBeenCalled();
  });

  it('choosing the already-selected option is a no-op', async () => {
    vi.mocked(useRegtestAccessStatus).mockReturnValue({ status: available as any, refresh });
    render(<RegtestAccessScreen />);
    await flush();
    expect(checkedOptions()).toEqual(['enabled']);

    fireEvent.click(option('enabled'));
    await flush();
    expect(screen.queryByTestId('regtest-access-modal')).toBeNull();
    expect(wallet.disableRegtestAccess).not.toHaveBeenCalled();
  });

  it('choosing Disabled goes through the background, confirms, and never touches the browser permission', async () => {
    vi.mocked(useRegtestAccessStatus).mockReturnValue({ status: available as any, refresh });
    let settle!: (status: unknown) => void;
    wallet.disableRegtestAccess.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    render(<RegtestAccessScreen />);
    await flush();

    fireEvent.click(option('disabled'));
    await flush();
    // The pending option shows a spinner while the background works.
    expect(option('disabled').querySelector('[data-testid="loading"]')).toBeTruthy();
    expect(checkedOptions()).toEqual([]);

    // The grant is still there afterwards (Chrome will not remove it through
    // the API for this manifest); only the acknowledgement is gone, and that
    // is a plain success, not something to warn about.
    await act(async () => {
      settle({ ...locked, permission: true, reason: 'acknowledgement_missing' });
    });
    expect(wallet.disableRegtestAccess).toHaveBeenCalledTimes(1);
    expect(tools.toastSuccess).toHaveBeenCalledWith('regtest_access_disabled');
    expect(tools.toastError).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByTestId('loading')).toBeNull();
    expect(Object.keys(wallet)).not.toContain('removeRegtestPermission');
  });

  it('shows no toast on a background failure and re-reads the state', async () => {
    vi.mocked(useRegtestAccessStatus).mockReturnValue({ status: available as any, refresh });
    wallet.disableRegtestAccess.mockRejectedValue(new Error('port closed'));
    render(<RegtestAccessScreen />);
    await flush();
    fireEvent.click(option('disabled'));
    await flush();

    expect(tools.toastError).not.toHaveBeenCalled();
    expect(tools.toastSuccess).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByTestId('loading')).toBeNull();
  });

  it('is inert in builds that ship the loopback permission as required', async () => {
    vi.mocked(useRegtestAccessStatus).mockReturnValue({ status: { ...available, gated: false } as any, refresh });
    render(<RegtestAccessScreen />);
    await flush();
    expect(checkedOptions()).toEqual(['enabled']);
    fireEvent.click(option('disabled'));
    await flush();
    expect(wallet.disableRegtestAccess).not.toHaveBeenCalled();
  });
});
