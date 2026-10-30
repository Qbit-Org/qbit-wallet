import type { CSSProperties, MouseEventHandler, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { colors } from '@/ui/theme/colors';
import { useBalanceCardLogic } from '@qbit/wallet-state';

import { BalanceCard } from './BalanceCard';

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
    onClick?: MouseEventHandler;
    'data-testid'?: string;
  }) =>
    React.createElement(
      'div',
      { style, onClick, 'data-testid': dataTestId, 'data-background': style?.backgroundColor },
      children
    );
  const Text = ({ text, 'data-testid': dataTestId }: { text?: string; 'data-testid'?: string }) =>
    React.createElement('span', { 'data-testid': dataTestId }, text);
  const Icon = ({ icon }: { icon?: string }) => React.createElement('span', { 'data-icon': icon });
  const Tooltip = ({ children, title }: { children?: ReactNode; title?: string }) =>
    React.createElement('div', { 'data-testid': 'tooltip', title }, children);
  const Spin = () => React.createElement('span', { 'data-testid': 'spin' });
  const Button = ({
    text,
    preset,
    loading,
    onClick,
    'data-testid': dataTestId
  }: {
    text?: string;
    preset?: string;
    loading?: boolean;
    onClick?: MouseEventHandler;
    'data-testid'?: string;
  }) =>
    React.createElement(
      'button',
      { disabled: loading, onClick, 'data-testid': dataTestId, 'data-preset': preset },
      text
    );
  return { Button, Column: Container, Icon, Row: Container, Spin, Text, Tooltip };
});
vi.mock('@/ui/components/RefreshButton', () => ({ RefreshButton: () => null }));
vi.mock('./QbitDisplay', async () => {
  const React = await import('react');
  return {
    QbitDisplay: ({ balance, preset }: { balance: string; preset?: string }) =>
      React.createElement('span', { 'data-testid': preset === 'sub' ? 'balance-split-amount' : 'balance-amount' }, balance)
  };
});
vi.mock('@qbit/wallet-state', () => ({ useBalanceCardLogic: vi.fn() }));

function renderCard(state: Partial<ReturnType<typeof useBalanceCardLogic>>) {
  const logic = {
    availableAmount: '0.00005000',
    unavailableAmount: '0.00000000',
    unavailableTipText: 'unavailable_tooltip',
    balanceValue: '0.00005000',
    t: (key: string) => key,
    isCurrentChainBalance: true,
    utxoLimitExceeded: false,
    utxoLimitExceededText: 'utxo_limit_exceeded_balance',
    balanceSplitUnknown: false,
    balanceSplitUnknownText: 'utxo_limit_exceeded_balance_detail',
    balanceLoading: false,
    balanceLoadFailed: false,
    balanceErrorText: undefined,
    isDetailExpanded: false,
    handleExpandToggle: vi.fn(),
    isBalanceHidden: false,
    handleHiddenToggle: vi.fn(),
    refreshBalance: vi.fn(),
    retryBalance: vi.fn(),
    isRetryingBalance: false,
    ...state
  };
  vi.mocked(useBalanceCardLogic).mockReturnValue(logic as unknown as ReturnType<typeof useBalanceCardLogic>);
  render(<BalanceCard />);
  return logic;
}

const overLimit = {
  availableAmount: '--',
  unavailableAmount: '--',
  balanceValue: '0.91000000',
  utxoLimitExceeded: true,
  balanceSplitUnknown: true
};

describe('BalanceCard', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows the split as unknown, with a line saying why, past the explorer UTXO limit (#341)', () => {
    renderCard({ ...overLimit, isDetailExpanded: true });

    const card = screen.getByTestId('wallet-balance-card');
    expect(card.textContent).toContain('0.91000000');
    expect(card.textContent).toContain('available--');
    expect(card.textContent).toContain('unavailable--');
    expect(card.textContent).not.toContain('0.00000000');
    expect(screen.getByTestId('balance-utxo-limit-note').textContent).toBe('utxo_limit_exceeded_balance');
    expect(screen.getByTestId('balance-split-unknown-note').textContent).toBe('utxo_limit_exceeded_balance_detail');
    // The tooltip explaining a measured Unavailable is not offered for an unknown one.
    expect(screen.queryByTestId('tooltip')).toBeNull();
  });

  it('shows the split line only in the expanded rows', () => {
    renderCard({ ...overLimit, isDetailExpanded: false });

    expect(screen.getByTestId('balance-utxo-limit-note')).toBeTruthy();
    expect(screen.queryByTestId('balance-split-unknown-note')).toBeNull();
  });

  it('shows measured amounts and no unknown line for an ordinary balance', () => {
    renderCard({ isDetailExpanded: true });

    const card = screen.getByTestId('wallet-balance-card');
    expect(card.textContent).toContain('available0.00005000');
    expect(card.textContent).toContain('unavailable0.00000000');
    expect(screen.getByTestId('tooltip').getAttribute('title')).toBe('unavailable_tooltip');
    expect(screen.queryByTestId('balance-utxo-limit-note')).toBeNull();
    expect(screen.queryByTestId('balance-split-unknown-note')).toBeNull();
  });

  it('shows the load error and a retry instead of a zero balance', () => {
    const logic = renderCard({
      balanceValue: '0.00000000',
      balanceLoadFailed: true,
      balanceErrorText: 'balance_load_error',
      isDetailExpanded: true
    });

    expect(screen.queryByTestId('balance-amount')).toBeNull();
    // Nothing loaded, so there is no breakdown either.
    expect(screen.queryByTestId('balance-split-amount')).toBeNull();
    expect(screen.getByTestId('balance-error-note').textContent).toBe('balance_load_error');
    expect(screen.getByTestId('wallet-balance-card').dataset.background).toBe(colors.neutralFill);
    expect(screen.getByTestId('balance-retry-button').dataset.preset).toBe('neutral');

    fireEvent.click(screen.getByTestId('balance-retry-button'));
    expect(logic.retryBalance).toHaveBeenCalledTimes(1);
    expect(logic.handleExpandToggle).not.toHaveBeenCalled();
  });

  it('keeps the last balance next to the refresh error', () => {
    renderCard({ balanceErrorText: 'balance_refresh_error' });

    expect(screen.getByTestId('balance-amount').textContent).toBe('0.00005000');
    expect(screen.getByTestId('balance-error-note').textContent).toBe('balance_refresh_error');
    expect(screen.getByTestId('balance-retry-button')).toBeTruthy();
    expect(screen.getByTestId('wallet-balance-card').dataset.background).toBe(colors.accent);
    expect(screen.getByTestId('balance-retry-button').dataset.preset).toBe('default');
  });

  it('keeps an over-limit balance and its unknown split next to the refresh error', () => {
    renderCard({ ...overLimit, isDetailExpanded: true, balanceErrorText: 'balance_refresh_error' });

    expect(screen.getByTestId('balance-amount').textContent).toBe('0.91000000');
    expect(screen.getByTestId('balance-error-note').textContent).toBe('balance_refresh_error');
    expect(screen.getByTestId('balance-utxo-limit-note')).toBeTruthy();
    expect(screen.getByTestId('balance-split-unknown-note')).toBeTruthy();
    expect(screen.getByTestId('wallet-balance-card').textContent).toContain('available--');
  });

  it('does not toggle the card while a retry is running', () => {
    const logic = renderCard({ balanceErrorText: 'balance_refresh_error', isRetryingBalance: true });

    expect((screen.getByTestId('balance-retry-button') as HTMLButtonElement).disabled).toBe(true);
    // The real Button drops its handler while loading, so the click reaches the error block.
    fireEvent.click(screen.getByTestId('balance-error'));
    expect(logic.retryBalance).not.toHaveBeenCalled();
    expect(logic.handleExpandToggle).not.toHaveBeenCalled();
  });

  it('shows no error without a failed refresh', () => {
    renderCard({});

    expect(screen.getByTestId('balance-amount').textContent).toBe('0.00005000');
    expect(screen.queryByTestId('balance-error')).toBeNull();
  });

  it('shows a spinner instead of a zero balance while the first balance loads', () => {
    renderCard({ balanceLoading: true, balanceValue: '--', isDetailExpanded: true });

    expect(screen.getByRole('status', { name: 'balance_loading' })).toBeTruthy();
    expect(screen.queryByTestId('balance-amount')).toBeNull();
    expect(screen.queryByTestId('balance-error')).toBeNull();
    expect(screen.getByTestId('wallet-balance-card').dataset.background).toBe(colors.accent);
    // No breakdown, or chevron to open one, until a balance loads.
    expect(screen.queryByText('available')).toBeNull();
    expect(document.querySelector('[data-icon="down"], [data-icon="up"]')).toBeNull();
  });
});
