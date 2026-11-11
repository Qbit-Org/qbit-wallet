import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/background/webapi/browser', () => ({
  browserTabsCreate: vi.fn().mockResolvedValue({ id: 7 })
}));

vi.mock('@/ui/components', () => {
  const Container = ({ children, 'data-testid': testId }: any) => <div data-testid={testId}>{children}</div>;

  return {
    Column: Container,
    Content: Container,
    Footer: Container,
    Layout: Container,
    Row: Container,
    Header: ({ LeftComponent, RightComponent }: any) => (
      <header>
        {LeftComponent}
        {RightComponent}
      </header>
    ),
    Icon: ({ icon }: any) => <span data-icon={icon} />,
    Text: ({ text }: any) => <span>{text}</span>,
    Button: ({ text, onClick, 'data-testid': testId }: any) => (
      <button data-testid={testId} onClick={onClick}>
        {text}
      </button>
    )
  };
});

vi.mock('@/ui/components/NavTabBar', () => ({
  NavTabBar: ({ tab }: any) => <nav data-testid="nav-tab-bar" data-tab={tab} />
}));

vi.mock('@/ui/components/SwitchNetworkBar', () => ({
  SwitchNetworkBar: () => <div data-testid="switch-network-bar" />
}));

import { browserTabsCreate } from '@/background/webapi/browser';

import MineTabScreen from '../src/ui/pages/Main/MineTabScreen';

describe('MineTabScreen', () => {
  afterEach(() => {
    cleanup();
    vi.mocked(browserTabsCreate).mockClear();
  });

  it('shows the Qbit Mine hero with the mine tab active', () => {
    render(<MineTabScreen />);

    expect(screen.getByText('Mine QBT. No hardware required.')).toBeTruthy();
    expect(screen.getByText('Qbit Mine')).toBeTruthy();
    expect(screen.getByText('Paid every pool block')).toBeTruthy();
    expect(screen.getByTestId('nav-tab-bar').getAttribute('data-tab')).toBe('mine');
  });

  it('opens qbit.org/mine with the extension UTM source in a new active tab', () => {
    render(<MineTabScreen />);

    fireEvent.click(screen.getByTestId('open-qbit-mine'));

    expect(browserTabsCreate).toHaveBeenCalledTimes(1);
    expect(browserTabsCreate).toHaveBeenCalledWith({
      url: 'https://qbit.org/mine?utm_source=qbit-wallet-extension',
      active: true
    });
  });
});
