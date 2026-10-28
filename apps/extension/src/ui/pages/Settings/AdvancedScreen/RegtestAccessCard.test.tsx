import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRegtestAccessStatus } from '@/ui/utils/regtestAccess';
import { useI18n } from '@qbit/wallet-state';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { RegtestAccessCard } from './RegtestAccessCard';

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
  const Text = ({ text, 'data-testid': dataTestId }: { text?: string; 'data-testid'?: string }) =>
    React.createElement('span', { 'data-testid': dataTestId }, text);
  const Icon = ({ icon }: { icon?: string }) => React.createElement('i', { 'data-testid': `icon-${icon}` });
  return { Card: Container, Icon, Row: Container, Text };
});

vi.mock('@/ui/theme/font', () => ({ fontSizes: { lg: 18 } }));

const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigateMock }));

vi.mock('@/ui/utils/regtestAccess', () => ({
  useRegtestAccessStatus: vi.fn(),
  isRegtestLocked: (status: any) => !status || (status.gated && status.state === 'locked')
}));

vi.mock('@qbit/wallet-state', () => ({
  useI18n: vi.fn()
}));

const locked = { state: 'locked', gated: true, permission: false, acknowledged: false, supported: true };
const available = { state: 'available', gated: true, permission: true, acknowledged: true, supported: true };
const flush = () => act(async () => undefined);

describe('RegtestAccessCard', () => {
  const refresh = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    refresh.mockResolvedValue(undefined);
  });

  it('is hidden in builds that do not gate regtest behind the optional permission', async () => {
    vi.mocked(useRegtestAccessStatus).mockReturnValue({
      status: { ...available, gated: false } as any,
      refresh
    });
    render(<RegtestAccessCard />);
    await flush();
    expect(screen.queryByTestId('regtest-access-card')).toBeNull();
  });

  it('is hidden until the first status read completes', async () => {
    vi.mocked(useRegtestAccessStatus).mockReturnValue({ status: null, refresh });
    render(<RegtestAccessCard />);
    await flush();
    expect(screen.queryByTestId('regtest-access-card')).toBeNull();
  });

  it.each([
    ['locked', locked, 'regtest_access_status_off'],
    ['available', available, 'regtest_access_status_on'],
    // Permission + acknowledgement exist; only the service check is pending or failing.
    ['unreachable', { ...available, state: 'unreachable' }, 'regtest_access_status_on']
  ])('shows the label, the %s state and a chevron, and opens the Local Regtest screen', async (_, status, state) => {
    vi.mocked(useRegtestAccessStatus).mockReturnValue({ status: status as any, refresh });
    render(<RegtestAccessCard />);
    await flush();

    expect(screen.getByText('local_regtest')).toBeTruthy();
    expect(screen.getByTestId('regtest-access-state').textContent).toBe(state);
    expect(screen.getByTestId('icon-right')).toBeTruthy();
    // No inline controls: the whole row is the affordance.
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('regtest_access_advanced_description')).toBeNull();

    fireEvent.click(screen.getByTestId('regtest-access-card'));
    expect(navigateMock).toHaveBeenCalledWith('/settings/regtest-access');
  });
});
