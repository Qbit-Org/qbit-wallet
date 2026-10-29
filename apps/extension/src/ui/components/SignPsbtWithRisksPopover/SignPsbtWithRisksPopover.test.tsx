import type { ChangeEventHandler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RiskType } from '@qbit/wallet-shared';
import type { DecodedPsbt } from '@qbit/wallet-shared';
import { useI18n } from '@qbit/wallet-state';

import { SignPsbtWithRisksPopover } from '.';

vi.mock('@qbit/wallet-state', () => ({
  useI18n: vi.fn()
}));

vi.mock('../FeeRateBar', () => ({ FeeRateBar: () => null }));

vi.mock('../Input', () => ({
  Input: ({ onChange, ...props }: { onChange?: ChangeEventHandler<HTMLInputElement>; 'data-testid'?: string }) => (
    <input onChange={onChange} data-testid={props['data-testid']} />
  )
}));

const decodedPsbt = {
  risks: [
    {
      type: RiskType.SCAMMER_ADDRESS,
      level: 'warning',
      title: 'Risk title',
      desc: 'Risk description'
    }
  ]
} as DecodedPsbt;

describe('SignPsbtWithRisksPopover confirmation readiness', () => {
  beforeEach(() => {
    vi.mocked(useI18n).mockReturnValue({
      t: (key: string) => key
    } as ReturnType<typeof useI18n>);
  });

  afterEach(() => {
    cleanup();
  });

  it('exposes readiness and preserves the typed confirmation gate', async () => {
    const onConfirm = vi.fn();
    render(<SignPsbtWithRisksPopover decodedPsbt={decodedPsbt} onConfirm={onConfirm} onClose={vi.fn()} />);

    const confirmationInput = screen.getByTestId('risk-confirmation-input');
    const confirmationButton = screen.getByTestId('risk-confirm-button');

    expect(confirmationButton.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(confirmationButton);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.change(confirmationInput, { target: { value: 'CONFIRM' } });
    await waitFor(() => expect(confirmationButton.getAttribute('aria-disabled')).toBe('false'));

    fireEvent.click(confirmationButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.change(confirmationInput, { target: { value: 'CONFIRM!' } });
    await waitFor(() => expect(confirmationButton.getAttribute('aria-disabled')).toBe('true'));

    fireEvent.click(confirmationButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('names an unrecognised output and keeps it behind the typed confirmation (#271)', () => {
    render(
      <SignPsbtWithRisksPopover
        decodedPsbt={
          {
            risks: [
              {
                type: RiskType.UNRECOGNISED_OUTPUT,
                level: 'danger',
                title: 'Unrecognised output',
                desc: 'An output pays a script that is neither yours nor the named recipient.'
              }
            ]
          } as DecodedPsbt
        }
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('unrecognised_output_risk_title')).toBeTruthy();
    expect(screen.getByText('unrecognised_output_risk_description')).toBeTruthy();
    expect(screen.getByTestId('risk-confirm-button').getAttribute('aria-disabled')).toBe('true');
  });

  it('names a fee only its share of the amount flagged a high fee, not a high rate', () => {
    const highFee = (highFeeAtNormalRate: boolean) =>
      ({
        feeRate: 15,
        risks: [{ type: RiskType.HIGH_FEE_RATE, level: 'warning', title: '', desc: '' }],
        spendSummary: {
          feeAssessment: {
            fee: 114_330,
            feeRate: 15,
            amount: 10_000,
            recommendedFeeRate: 9,
            reasons: ['large_share_of_amount'],
            ...(highFeeAtNormalRate ? { highFeeAtNormalRate: true } : {})
          }
        }
      }) as unknown as DecodedPsbt;

    render(<SignPsbtWithRisksPopover decodedPsbt={highFee(true)} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('high_fee_risk_title')).toBeTruthy();
    expect(screen.getByText('high_fee_risk_description')).toBeTruthy();
    expect(screen.queryByText('high_fee_rate_risk_title')).toBeNull();
    expect(screen.getByTestId('risk-confirm-button').getAttribute('aria-disabled')).toBe('true');
    // The detail beside the rate says the same.
    fireEvent.click(screen.getByText('view'));
    expect(screen.getByText('high_fee_risk_title')).toBeTruthy();
    expect(screen.getByText('15 bits/vB')).toBeTruthy();
    cleanup();

    render(<SignPsbtWithRisksPopover decodedPsbt={highFee(false)} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('high_fee_rate_risk_title')).toBeTruthy();
    expect(screen.queryByText('high_fee_risk_title')).toBeNull();
  });
});
