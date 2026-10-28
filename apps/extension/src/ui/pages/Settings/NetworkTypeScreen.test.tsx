import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRegtestAccessStatus } from '@/ui/utils/regtestAccess';
import { useChainType, useChangeChainTypeCallback, useI18n, useReloadAccounts, useTools } from '@qbit/wallet-state';
import { ChainType } from '@qbit/wallet-types';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import NetworkTypeScreen from './NetworkTypeScreen';

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({
    children,
    onClick,
    'data-testid': dataTestId
  }: {
    children?: ReactNode;
    onClick?: () => void;
    'data-testid'?: string;
  }) => React.createElement('div', { onClick, 'data-testid': dataTestId }, children);
  const Text = ({ text }: { text?: string }) => React.createElement('span', null, text);
  const Button = ({
    text,
    onClick,
    'data-testid': dataTestId
  }: {
    text?: string;
    onClick?: (e: any) => void;
    'data-testid'?: string;
  }) => React.createElement('button', { onClick, 'data-testid': dataTestId }, text);
  const Header = ({ title }: { title?: string }) => React.createElement('div', null, title);
  const Icon = ({ icon }: { icon?: string }) => React.createElement('i', { 'data-testid': `icon-${icon}` });
  const Image = () => null;
  return {
    Button,
    Card: Container,
    Column: Container,
    Content: Container,
    Header,
    Icon,
    Image,
    Layout: Container,
    Row: Container,
    Text
  };
});

vi.mock('@/shared/constant', () => ({ IMAGE_SOURCE_MAP: {} }));

vi.mock('../MainRoute', () => ({ useNavigate: () => navigateMock }));
const navigateMock = vi.fn();

vi.mock('./RegtestAccessModal', async () => {
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
  isRegtestLocked: (status: any) => !status || (status.gated && status.state === 'locked'),
  regtestAccessErrorMessage: (error: any, t: (key: string) => string) =>
    error?.code === -12
      ? t('regtest_access_not_enabled')
      : error?.code === -13
        ? t('regtest_service_unavailable')
        : error?.code === -14
          ? t('regtest_service_unexpected')
          : null
}));

vi.mock('@qbit/wallet-state', () => ({
  useChainType: vi.fn(),
  useChangeChainTypeCallback: vi.fn(),
  useI18n: vi.fn(),
  useReloadAccounts: vi.fn(),
  useTools: vi.fn()
}));

const locked = { state: 'locked', gated: true, permission: false, acknowledged: false, supported: true };
const available = { state: 'available', gated: true, permission: true, acknowledged: true, supported: true };
const flush = () => act(async () => undefined);

describe('NetworkTypeScreen local regtest gate', () => {
  const changeChainType = vi.fn();
  const reloadAccounts = vi.fn();
  const tools = { toastError: vi.fn(), toastSuccess: vi.fn() };
  const permissionRequest = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    (globalThis as any).chrome = { permissions: { request: permissionRequest, contains: vi.fn() } };
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useChainType).mockReturnValue(ChainType.QBIT_MAINNET);
    vi.mocked(useChangeChainTypeCallback).mockReturnValue(changeChainType);
    vi.mocked(useReloadAccounts).mockReturnValue(reloadAccounts);
    vi.mocked(useTools).mockReturnValue(tools as any);
    changeChainType.mockResolvedValue(undefined);
  });

  it('renders a locked Local Regtest row that opens the explanation instead of switching', async () => {
    vi.mocked(useRegtestAccessStatus).mockReturnValue({ status: locked as any, refresh: vi.fn() });
    render(<NetworkTypeScreen />);
    await flush();

    expect(screen.getByText('local_regtest')).toBeTruthy();
    // The row is the only affordance: no separate Enable… button.
    expect(screen.queryByTestId('network-regtest-enable')).toBeNull();
    expect(screen.queryByText('enable_ellipsis')).toBeNull();
    expect(screen.queryByTestId('regtest-access-modal')).toBeNull();
    // Merely opening the screen must not prompt.
    expect(permissionRequest).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('network-option-QBIT_REGTEST'));
    await flush();
    expect(screen.getByTestId('regtest-access-modal')).toBeTruthy();
    expect(changeChainType).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(permissionRequest).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('modal-back'));
    await flush();
    expect(screen.queryByTestId('regtest-access-modal')).toBeNull();
    expect(changeChainType).not.toHaveBeenCalled();
  });

  it('shows the loopback endpoint under the regtest label in the fixed-height label column', async () => {
    vi.mocked(useRegtestAccessStatus).mockReturnValue({ status: locked as any, refresh: vi.fn() });
    render(<NetworkTypeScreen />);
    await flush();

    const regtestRow = screen.getByTestId('network-option-QBIT_REGTEST');
    expect(regtestRow.textContent).toContain('http://127.0.0.1:3002');
    // The label column is the fixed-height variant (its layout contract is
    // covered by NetworkOptionLabel.test.tsx; this mock drops styles).
    expect(screen.getByTestId('network-option-label')).toBeTruthy();
    expect(screen.getByTestId('network-option-QBIT_MAINNET').textContent).not.toContain('http://');
  });

  it('treats an unknown capability status as locked', async () => {
    vi.mocked(useRegtestAccessStatus).mockReturnValue({ status: null, refresh: vi.fn() });
    render(<NetworkTypeScreen />);
    await flush();
    fireEvent.click(screen.getByTestId('network-option-QBIT_REGTEST'));
    await flush();
    expect(screen.getByTestId('regtest-access-modal')).toBeTruthy();
    expect(changeChainType).not.toHaveBeenCalled();
  });

  it('switches to regtest after the explanation flow succeeds (selection was the initiating action)', async () => {
    vi.mocked(useRegtestAccessStatus).mockReturnValue({ status: locked as any, refresh: vi.fn() });
    render(<NetworkTypeScreen />);
    await flush();
    fireEvent.click(screen.getByTestId('network-option-QBIT_REGTEST'));
    await flush();
    fireEvent.click(screen.getByTestId('modal-enabled'));
    await flush();

    expect(changeChainType).toHaveBeenCalledWith(ChainType.QBIT_REGTEST);
    expect(reloadAccounts).toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith('MainScreen');
    expect(tools.toastSuccess).toHaveBeenCalled();
  });

  it('selects regtest directly once the capability is available', async () => {
    vi.mocked(useRegtestAccessStatus).mockReturnValue({ status: available as any, refresh: vi.fn() });
    render(<NetworkTypeScreen />);
    await flush();

    expect(screen.queryByText('local_regtest')).toBeNull();
    expect(screen.getByText('Qbit Regtest')).toBeTruthy();
    fireEvent.click(screen.getByTestId('network-option-QBIT_REGTEST'));
    await flush();
    expect(changeChainType).toHaveBeenCalledWith(ChainType.QBIT_REGTEST);
    expect(navigateMock).toHaveBeenCalledWith('MainScreen');
  });

  it('keeps the current network and shows the distinct error when the background rejects the switch', async () => {
    vi.mocked(useRegtestAccessStatus).mockReturnValue({ status: available as any, refresh: vi.fn() });
    changeChainType.mockRejectedValue({ code: -13, message: 'regtest_service_unavailable' });
    render(<NetworkTypeScreen />);
    await flush();
    fireEvent.click(screen.getByTestId('network-option-QBIT_REGTEST'));
    await flush();

    expect(tools.toastError).toHaveBeenCalledWith('regtest_service_unavailable');
    expect(navigateMock).not.toHaveBeenCalled();
    expect(reloadAccounts).not.toHaveBeenCalled();
  });

  it('does not gate the public networks', async () => {
    vi.mocked(useRegtestAccessStatus).mockReturnValue({ status: locked as any, refresh: vi.fn() });
    render(<NetworkTypeScreen />);
    await flush();
    fireEvent.click(screen.getByTestId('network-option-QBIT_TESTNET4'));
    await flush();
    expect(changeChainType).toHaveBeenCalledWith(ChainType.QBIT_TESTNET4);
    expect(screen.queryByTestId('regtest-access-modal')).toBeNull();
  });
});
