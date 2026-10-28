import type { CSSProperties, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { useI18n, useQbitUnit } from '@qbit/wallet-state';

import TransactionOverviewSection from './TransactionOverviewSection';

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
  const Text = ({ text, 'data-testid': dataTestId }: { text?: string; 'data-testid'?: string }) =>
    React.createElement('span', { 'data-testid': dataTestId }, text);
  const Icon = () => null;

  return {
    Card: Container,
    Column: Container,
    Grid: Container,
    Icon,
    Row: Container,
    Text,
    Tooltip: Container
  };
});

vi.mock('@/ui/utils', () => ({
  amountToSatoshis: (val: unknown) => Number(val)
}));

vi.mock('@qbit/wallet-state', () => ({
  useI18n: vi.fn(),
  useQbitUnit: vi.fn()
}));

const decodedPsbt = {
  isCompleted: true,
  fee: 3860,
  feeRate: 1,
  recommendedFeeRate: 1,
  shouldWarnFeeRate: false
} as any;

function toSignDataWithBudget() {
  return {
    psbtHex: '00',
    toSignInputs: [],
    signatureBudget: {
      required: 2,
      cached: 1,
      remainingBefore: 100,
      remainingAfter: 98,
      limit: 1073741824
    }
  } as any;
}

describe('TransactionOverviewSection signature budget row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    vi.mocked(useI18n).mockReturnValue({
      t: (key: string, substitutions?: string | string[]) =>
        substitutions === undefined
          ? key
          : `${key}:${Array.isArray(substitutions) ? substitutions.join(',') : substitutions}`
    } as any);
    vi.mocked(useQbitUnit).mockReturnValue('QBT' as any);
  });

  it('shows the exact preflighted P2MR signature-budget impact', () => {
    render(
      <TransactionOverviewSection decodedPsbt={decodedPsbt} networkFee={0.0000386} toSignData={toSignDataWithBudget()} />
    );

    expect(screen.getByTestId('psbt-signature-budget')).toBeTruthy();
    expect(screen.getByText('0.0000386 QBT')).toBeTruthy();
    expect(screen.getByText('1 bits/vB')).toBeTruthy();
    expect(screen.getByTestId('psbt-network-fee-base-units').textContent).toBe('Exact fee: 3860 bits');
    expect(screen.getByText('Signatures: 2 new • 1 cached')).toBeTruthy();
    expect(screen.getByText('Signature budget: 100 before, 98 after')).toBeTruthy();
  });

  it('renders no budget row when the approval has no preflighted budget', () => {
    render(
      <TransactionOverviewSection
        decodedPsbt={decodedPsbt}
        networkFee={0.0000386}
        toSignData={{ psbtHex: '00', toSignInputs: [] } as any}
      />
    );

    expect(screen.queryByTestId('psbt-signature-budget')).toBeNull();
  });

  it('shows a restored-floor lower bound without an exact remaining budget', () => {
    const toSignData = toSignDataWithBudget();
    toSignData.signatureBudget.restoredFloorRisk = {
      recoveryStatus: 'seed-only-restored',
      counterConfidence: 'chain-floor-only',
      knownOnChainSignatures: 42,
      challengeId: 'challenge-42'
    };

    render(
      <TransactionOverviewSection
        decodedPsbt={decodedPsbt}
        networkFee={0.0000386}
        toSignData={toSignData}
      />
    );

    expect(screen.getByText('qbit_known_onchain_usage_lower_bound:42+')).toBeTruthy();
    expect(screen.queryByText('Signature budget: 100 before, 98 after')).toBeNull();
  });

  it('says when the fee was not compared with recommended rates (#271)', () => {
    render(
      <TransactionOverviewSection
        decodedPsbt={{
          ...decodedPsbt,
          spendSummary: { feeAssessment: { fee: 3860, feeRate: 1, amount: 10_000, reasons: [] } }
        }}
        networkFee={0.0000386}
      />
    );
    expect(screen.getByTestId('psbt-fee-recommendation-unavailable').textContent).toBe(
      'fee_warning_recommendation_unavailable'
    );

    cleanup();
    render(
      <TransactionOverviewSection
        decodedPsbt={{
          ...decodedPsbt,
          spendSummary: {
            feeAssessment: { fee: 3860, feeRate: 1, amount: 10_000, recommendedFeeRate: 1, reasons: [] }
          }
        }}
        networkFee={0.0000386}
      />
    );
    expect(screen.queryByTestId('psbt-fee-recommendation-unavailable')).toBeNull();
  });
});
