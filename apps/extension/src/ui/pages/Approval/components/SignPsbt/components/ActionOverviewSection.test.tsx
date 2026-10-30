import type { CSSProperties, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { useActionOverviewSectionLogic, useI18n, useQbitUnit } from '@qbit/wallet-state';

import ActionOverviewSection from './ActionOverviewSection';

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
  const Text = ({ text, 'data-testid': dataTestId }: { text?: string; 'data-testid'?: string }) =>
    React.createElement('span', { 'data-testid': dataTestId }, text);
  return { Card: Container, Column: Container, Icon: () => null, Image: () => null, Row: Container, Text };
});

vi.mock('@/ui/components/AddressText', () => ({ AddressText: () => null }));
vi.mock('@/shared/constant', () => ({ IMAGE_SOURCE_MAP: {} }));
vi.mock('@/ui/theme/colors', () => ({ colors: { border: '' } }));
vi.mock('@/ui/utils', () => ({ shortAddress: (value: string) => value }));
vi.mock('@qbit/base-utils', () => ({
  numUtils: { satoshisToAmount: (value: number) => (value / 100_000_000).toFixed(8) }
}));
vi.mock('@qbit/wallet-shared', () => ({
  PsbtActionDetailType: { TEXT: 'TEXT', ADDRESS: 'ADDRESS', AMOUNT: 'AMOUNT', SATOSHIS: 'SATOSHIS' }
}));
vi.mock('@qbit/wallet-state', () => ({
  useActionOverviewSectionLogic: vi.fn(),
  useI18n: vi.fn(),
  useQbitUnit: vi.fn()
}));

function renderWithSpend(spend: unknown) {
  vi.mocked(useActionOverviewSectionLogic).mockReturnValue({
    action: { name: 'sign_transaction', description: '', details: [] },
    chain: { icon: 'qbit', iconLabel: 'Qbit' },
    spend
  } as any);
  return render(<ActionOverviewSection action={{} as any} decodedPsbt={{} as any} />);
}

describe('ActionOverviewSection spend summary (#271)', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useQbitUnit).mockReturnValue('QBT' as any);
  });

  it('leads with the amount leaving the wallet and how it splits', () => {
    renderWithSpend({ netSpend: 103_860, breakdown: 'payments + fee', feeWarnings: [] });

    expect(screen.getByTestId('psbt-net-spend').textContent).toContain('net_spend_leaves_wallet');
    expect(screen.getByTestId('psbt-net-spend-amount').textContent).toBe('0.00103860 QBT');
    expect(screen.getByTestId('psbt-net-spend-breakdown').textContent).toBe('payments + fee');
    expect(screen.queryByTestId('psbt-fee-warning')).toBeNull();
    expect(screen.queryByTestId('psbt-unrecognised-outputs')).toBeNull();
  });

  it('shows a net gain as received, without the payment split', () => {
    renderWithSpend({ netSpend: -490_000, breakdown: 'payments + fee', feeWarnings: [] });

    expect(screen.getByTestId('psbt-net-spend').textContent).toContain('receive');
    expect(screen.getByTestId('psbt-net-spend-amount').textContent).toBe('0.00490000 QBT');
    expect(screen.queryByTestId('psbt-net-spend-breakdown')).toBeNull();
  });

  it('says the amount is unknown rather than showing zero', () => {
    renderWithSpend({ feeWarnings: [] });

    expect(screen.getByTestId('psbt-net-spend-amount').textContent).toBe('net_spend_unknown');
  });

  it('shows the fee warning and the unrecognised outputs above the transaction details', () => {
    renderWithSpend({
      netSpend: 1_644_000,
      feeWarningTitle: 'the_fee_rate_is_much_higher_than_recommended_fee_rate',
      feeWarnings: ['line one', 'line two'],
      unrecognisedOutputs: 'unrecognised outputs: 1'
    });

    expect(screen.getByTestId('psbt-fee-warning').textContent).toBe(
      'the_fee_rate_is_much_higher_than_recommended_fee_rateline oneline two'
    );
    expect(screen.getByTestId('psbt-unrecognised-outputs').textContent).toBe('unrecognised outputs: 1');
  });

  it('renders no summary when the decode carries none', () => {
    renderWithSpend(undefined);

    expect(screen.queryByTestId('psbt-net-spend')).toBeNull();
  });
});
