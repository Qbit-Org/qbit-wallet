import type { CSSProperties, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useI18n, useSetThemeModeCallback, useThemeMode } from '@qbit/wallet-state';

import AppearanceScreen from './AppearanceScreen';

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
  const Header = ({ title }: { title?: string }) => React.createElement('div', null, title);
  const IconStub = ({ icon }: { icon?: string }) =>
    React.createElement('i', { 'data-testid': `icon-${icon}` });

  return {
    Card: Container,
    Column: Container,
    Content: Container,
    Header,
    Icon: IconStub,
    Layout: Container,
    OptionListCard: Container,
    Row: Container,
    Text
  };
});

vi.mock('@qbit/wallet-shared', () => ({
  THEME_MODES: ['light', 'dark', 'system']
}));

vi.mock('@qbit/wallet-state', () => ({
  useI18n: vi.fn(),
  useSetThemeModeCallback: vi.fn(),
  useThemeMode: vi.fn()
}));

describe('AppearanceScreen', () => {
  const setThemeMode = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useThemeMode).mockReturnValue('system');
    vi.mocked(useSetThemeModeCallback).mockReturnValue(setThemeMode);
  });

  it('renders the light, dark and system options with the current one checked', () => {
    render(<AppearanceScreen />);

    expect(screen.getByTestId('appearance-option-light')).toBeTruthy();
    expect(screen.getByTestId('appearance-option-dark')).toBeTruthy();
    expect(screen.getByTestId('appearance-option-system')).toBeTruthy();
    expect(screen.getByText('theme_light')).toBeTruthy();
    expect(screen.getByText('theme_dark')).toBeTruthy();
    expect(screen.getByText('theme_system')).toBeTruthy();
    expect(screen.getByTestId('icon-checked')).toBeTruthy();
  });

  it('persists a newly selected mode', () => {
    render(<AppearanceScreen />);

    fireEvent.click(screen.getByTestId('appearance-option-dark'));
    expect(setThemeMode).toHaveBeenCalledWith('dark');
  });

  it('does not re-persist the already selected mode', () => {
    render(<AppearanceScreen />);

    fireEvent.click(screen.getByTestId('appearance-option-system'));
    expect(setThemeMode).not.toHaveBeenCalled();
  });
});
