import type { CSSProperties, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { useDeveloperMode, useI18n, useNavigation, useTools, useVersionInfo } from '@qbit/wallet-state';

import AboutUsScreen from './AboutUsScreen';

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
  const Text = ({
    text,
    'data-testid': dataTestId
  }: {
    text?: string;
    'data-testid'?: string;
  }) => React.createElement('span', { 'data-testid': dataTestId }, text);
  const Header = ({ title }: { title?: string }) => React.createElement('div', null, title);
  const IconStub = () => null;

  return {
    Column: Container,
    Content: Container,
    Header,
    Icon: IconStub,
    Layout: Container,
    Row: Container,
    Text
  };
});

vi.mock('@/ui/theme/colors', () => ({ colors: { border: '', shadow: '', accent: '', accentDark: '' } }));
vi.mock('@/ui/theme/spacing', () => ({ spacing: { tiny: 4, small: 8 } }));
vi.mock('@/ui/utils', () => ({
  copyToClipboard: vi.fn(async () => undefined),
  shortAddress: (value: string) => `${value.slice(0, 8)}...${value.slice(-8)}`
}));

vi.mock('@qbit/wallet-shared', () => ({
  UPDATE_URL: 'https://example.test/update',
  PlatformEnv: {
    VERSION: '0.1.0',
    CORE_RELEASE_TAG: 'v1.0.0',
    CORE_RELEASE_COMMIT: '7ebcddb622d6e639041f005a189b048ec2a221fe'
  }
}));

vi.mock('@qbit/wallet-state', () => ({
  useDeveloperMode: vi.fn(),
  useI18n: vi.fn(),
  useNavigation: vi.fn(),
  useSetDeveloperModeCallback: vi.fn(() => vi.fn()),
  useTools: vi.fn(),
  useVersionInfo: vi.fn()
}));

describe('AboutUsScreen consensus provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useNavigation).mockReturnValue({ goBack: vi.fn(), navToUrl: vi.fn() } as any);
    vi.mocked(useTools).mockReturnValue({ toastSuccess: vi.fn() } as any);
    vi.mocked(useDeveloperMode).mockReturnValue(false);
    vi.mocked(useVersionInfo).mockReturnValue({ currentVesion: '0.1.0', latestVersion: '' } as any);
  });

  it('shows the signed Qbit Core runtime pin', () => {
    render(<AboutUsScreen />);

    expect(screen.getByTestId('about-provenance')).toBeTruthy();
    expect(screen.getByText('provenance')).toBeTruthy();
    expect(screen.getByText('v1.0.0')).toBeTruthy();
    expect(screen.getByText('7ebcddb6...c2a221fe')).toBeTruthy();
  });
});
