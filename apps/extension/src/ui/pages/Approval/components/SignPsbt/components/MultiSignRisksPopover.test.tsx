import type { ChangeEventHandler, CSSProperties, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RiskType, type LocalPsbtSummary, type Risk } from '@qbit/wallet-shared';
import { useI18n } from '@qbit/wallet-state';

import MultiSignRisksPopover from './MultiSignRisksPopover';

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
  const Button = ({
    text,
    disabled,
    onClick,
    'data-testid': dataTestId
  }: {
    text?: string;
    disabled?: boolean;
    onClick?: () => void;
    'data-testid'?: string;
  }) => React.createElement('button', { disabled, onClick, 'data-testid': dataTestId }, text);
  const Input = ({
    onChange,
    'data-testid': dataTestId
  }: {
    onChange?: ChangeEventHandler<HTMLInputElement>;
    'data-testid'?: string;
  }) => React.createElement('input', { onChange, 'data-testid': dataTestId });
  const Text = ({ text }: { text?: string }) => React.createElement('span', null, text);
  return { Button, Column: Container, Icon: () => null, Input, Row: Container, Text };
});

vi.mock('@/ui/components/Popover', async () => {
  const React = await import('react');
  return {
    Popover: ({ children, 'data-testid': dataTestId }: { children?: ReactNode; 'data-testid'?: string }) =>
      React.createElement('div', { 'data-testid': dataTestId }, children)
  };
});

vi.mock('@qbit/wallet-state', () => ({
  useI18n: vi.fn()
}));

const HIGH_FEE: Risk = { type: RiskType.HIGH_FEE_RATE, level: 'warning', title: '', desc: '' };
const UNRECOGNISED: Risk = { type: RiskType.UNRECOGNISED_OUTPUT, level: 'danger', title: '', desc: '' };

function summary(risks: Risk[][]): LocalPsbtSummary {
  return {
    totalFee: 0,
    totalInput: 0,
    completedCount: risks.length,
    hasSighashNone: false,
    parseErrorCount: 0,
    items: risks.map((itemRisks, index) => ({
      inputCount: 1,
      outputCount: 2,
      feeRate: index === 1 ? '400.00' : '1.00',
      fee: 100,
      totalInput: 10_000,
      isCompleted: true,
      hasSighashNone: false,
      parseError: false,
      risks: itemRisks
    })),
    account: 'qbrt1zaccount',
    chain: 'QBIT_REGTEST' as LocalPsbtSummary['chain']
  };
}

describe('MultiSignRisksPopover (#367)', () => {
  beforeEach(() => {
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as ReturnType<typeof useI18n>);
  });

  afterEach(cleanup);

  it('names each flagged transaction with its risks and gates signing on the typed confirmation', () => {
    const onConfirm = vi.fn();
    render(
      <MultiSignRisksPopover
        summary={summary([[], [HIGH_FEE], [UNRECOGNISED]])}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />
    );

    expect(screen.queryByTestId('multisign-risk-transaction-0')).toBeNull();
    const highFee = screen.getByTestId('multisign-risk-transaction-1');
    expect(highFee.textContent).toContain('transaction 2');
    expect(highFee.textContent).toContain('400.00 bits/vB');
    expect(highFee.textContent).toContain('high_fee_rate_risk_title');
    const unrecognised = screen.getByTestId('multisign-risk-transaction-2');
    expect(unrecognised.textContent).toContain('transaction 3');
    expect(unrecognised.textContent).toContain('unrecognised_output_risk_title');
    expect(screen.getByText('high_fee_rate_risk_description')).not.toBeNull();
    expect(screen.getByText('unrecognised_output_risk_description')).not.toBeNull();

    const confirm = screen.getByTestId('multisign-risk-confirm-button') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('multisign-risk-confirmation-input'), { target: { value: 'confirm' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('offers no confirmation for a critical risk', () => {
    render(
      <MultiSignRisksPopover
        summary={summary([[{ ...UNRECOGNISED, level: 'critical' }], []])}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.queryByTestId('multisign-risk-confirm-button')).toBeNull();
    expect(screen.queryByTestId('multisign-risk-confirmation-input')).toBeNull();
  });

  it('names a fee only its share of the amount flagged a high fee, and explains each kind once', () => {
    const batch = summary([[HIGH_FEE], [HIGH_FEE], [HIGH_FEE]]);
    const shareOnly = {
      fee: 114_330,
      feeRate: 15,
      amount: 10_000,
      recommendedFeeRate: 9,
      reasons: ['large_share_of_amount' as const]
    };
    const spendSummary = (feeAssessment: object) =>
      ({ feeAssessment }) as unknown as NonNullable<LocalPsbtSummary['items'][number]['spendSummary']>;
    batch.items[0]!.spendSummary = spendSummary({ ...shareOnly, highFeeAtNormalRate: true });
    batch.items[2]!.spendSummary = spendSummary({ ...shareOnly, highFeeAtNormalRate: true });
    render(<MultiSignRisksPopover summary={batch} onConfirm={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByTestId('multisign-risk-transaction-0').textContent).toContain('high_fee_risk_title');
    expect(screen.getByTestId('multisign-risk-transaction-1').textContent).toContain('high_fee_rate_risk_title');
    expect(screen.getByTestId('multisign-risk-transaction-2').textContent).toContain('high_fee_risk_title');
    expect(screen.getAllByText('high_fee_risk_description')).toHaveLength(1);
    expect(screen.getAllByText('high_fee_rate_risk_description')).toHaveLength(1);
  });
});
