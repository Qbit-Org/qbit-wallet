import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { useBalanceCardLogic } from '@qbit/wallet-state';

import { BalanceCard } from './BalanceCard';

vi.mock('@qbit/wallet-state', () => ({
  useBalanceCardLogic: vi.fn(),
  useQbitUnit: vi.fn(() => 'QBT'),
  useQbitDisplayLogic: (balance: string) => ({
    totalAmountMainPart: balance.slice(0, -8),
    totalAmountSubPart: balance.slice(-8)
  })
}));

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const View = ({ children, 'data-testid': dataTestId }: any) =>
    React.createElement('div', { 'data-testid': dataTestId }, children);
  return {
    Column: View,
    Icon: () => null,
    Row: View,
    Text: ({ text, 'data-testid': dataTestId }: any) =>
      React.createElement('span', { 'data-testid': dataTestId }, text),
    Tooltip: ({ children, title }: any) => React.createElement('div', { 'data-testid': 'tooltip', title }, children)
  };
});

vi.mock('@/ui/components/RefreshButton', () => ({ RefreshButton: () => null }));

function mockLogic(overrides: Partial<ReturnType<typeof useBalanceCardLogic>>) {
  vi.mocked(useBalanceCardLogic).mockReturnValue({
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
    isDetailExpanded: true,
    handleExpandToggle: vi.fn(),
    isBalanceHidden: false,
    handleHiddenToggle: vi.fn(),
    refreshBalance: vi.fn(),
    ...overrides
  } as unknown as ReturnType<typeof useBalanceCardLogic>);
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
    mockLogic(overLimit);
    render(<BalanceCard />);

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
    mockLogic({ ...overLimit, isDetailExpanded: false });
    render(<BalanceCard />);

    expect(screen.getByTestId('balance-utxo-limit-note')).toBeTruthy();
    expect(screen.queryByTestId('balance-split-unknown-note')).toBeNull();
  });

  it('shows measured amounts and no unknown line for an ordinary balance', () => {
    mockLogic({});
    render(<BalanceCard />);

    const card = screen.getByTestId('wallet-balance-card');
    expect(card.textContent).toContain('available0.00005000');
    expect(card.textContent).toContain('unavailable0.00000000');
    expect(screen.getByTestId('tooltip').getAttribute('title')).toBe('unavailable_tooltip');
    expect(screen.queryByTestId('balance-utxo-limit-note')).toBeNull();
    expect(screen.queryByTestId('balance-split-unknown-note')).toBeNull();
  });
});
