import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useTxCreateScreenLogic } from '@qbit/wallet-state';

import TxCreateScreen from './TxCreateScreen';

vi.mock('@qbit/wallet-state', () => ({
  useNavigation: vi.fn(() => ({ navToUtxoTools: vi.fn() })),
  useTxCreateScreenLogic: vi.fn()
}));

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const View = ({ children, ...props }: any) => React.createElement('div', props, children);
  return {
    Button: View,
    Card: View,
    Column: View,
    Content: View,
    Header: View,
    Icon: View,
    Image: View,
    Input: View,
    Layout: View,
    Row: View,
    Text: ({ text, ...props }: any) => React.createElement('span', props, text),
    Tooltip: View
  };
});

vi.mock('@/ui/components/FeeRateBar', () => ({
  FeeRateBar: ({ headerRight }: any) => <div>fee-rate-bar{headerRight}</div>
}));
vi.mock('@/ui/components/RBFBar', () => ({ RBFBar: () => null }));

describe('TxCreateScreen fee details', () => {
  beforeEach(() => {
    vi.mocked(useTxCreateScreenLogic).mockReturnValue({
      headerTitle: 'Send QBT',
      chain: { icon: 'qbitMainnet', enum: 'QBIT_MAINNET' },
      toInfo: { address: '', domain: '' },
      onAddressInputChange: vi.fn(),
      toSatoshis: 6_000,
      inputAmount: '0.00006000',
      onAmountInputChange: vi.fn(),
      onAmountMaxClick: vi.fn(),
      enableRBF: true,
      onRBFChange: vi.fn(),
      memo: '',
      onMemoChange: vi.fn(),
      feeDetail: {
        estimatedFee: 4_000,
        inputCount: 1,
        estimatedVsize: 3_817,
        changeDroppedSats: 183,
        maximumTotalFee: 38_170_000,
        inputsDominateFee: true
      },
      showUnavailable: false,
      availableAmount: '0.00010000',
      unavailableAmount: '0',
      showImmature: false,
      immatureAmount: '0',
      showPending: false,
      pendingAmount: '0',
      unavailableTipText: '',
      qbitUnit: 'QBT',
      t: (key: string, substitutions?: string | string[]) =>
        substitutions ? `${key}:${(Array.isArray(substitutions) ? substitutions : [substitutions]).join(',')}` : key,
      walletConfig: { disableUtxoTools: true },
      isSpecialLocale: false,
      error: '',
      disabled: false,
      onClickNext: vi.fn()
    } as ReturnType<typeof useTxCreateScreenLogic>);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders exact paid fee and the separately folded remainder', () => {
    render(<TxCreateScreen />);

    expect(screen.getByTestId('tx-size-estimate').textContent).toBe('estimated_inputs_and_size:1,3.8 · 4000 bits');
    expect(screen.queryByTestId('tx-input-dominance-note')).toBeNull();
    expect(screen.getByTestId('tx-change-drop-note').textContent).toBe('change_below_dust_added_to_fee:183');
    expect(screen.queryByTestId('tx-consolidate-button')).toBeNull();
  });

  it('offers consolidation for an account over the explorer limit (#277)', () => {
    const onClickConsolidate = vi.fn();
    vi.mocked(useTxCreateScreenLogic).mockReturnValue({
      ...vi.mocked(useTxCreateScreenLogic)(),
      showConsolidate: true,
      onClickConsolidate
    });
    render(<TxCreateScreen />);

    fireEvent.click(screen.getByTestId('tx-consolidate-button'));
    expect(onClickConsolidate).toHaveBeenCalledTimes(1);
  });

  it('shows what leaves the wallet and why its fee is abnormal (#271)', () => {
    vi.mocked(useTxCreateScreenLogic).mockReturnValue({
      ...vi.mocked(useTxCreateScreenLogic)(),
      spendSummary: {
        totalSpend: '0.01644000',
        feeWarningTitle: 'the_fee_rate_is_much_higher_than_recommended_fee_rate',
        feeWarnings: ['fee_warning_above_recommended:400,400,1'],
        feeRecommendationUnavailable: undefined
      }
    });
    render(<TxCreateScreen />);

    expect(screen.getByTestId('tx-total-spend').textContent).toBe('0.01644000 QBT');
    expect(screen.getByTestId('tx-fee-warning').textContent).toBe(
      'the_fee_rate_is_much_higher_than_recommended_fee_ratefee_warning_above_recommended:400,400,1'
    );
    expect(screen.queryByTestId('tx-fee-recommendation-unavailable')).toBeNull();
  });

  it('says when the fee could not be compared with recommended rates (#271)', () => {
    vi.mocked(useTxCreateScreenLogic).mockReturnValue({
      ...vi.mocked(useTxCreateScreenLogic)(),
      spendSummary: {
        totalSpend: '0.00103860',
        feeWarningTitle: undefined,
        feeWarnings: [],
        feeRecommendationUnavailable: 'fee_warning_recommendation_unavailable'
      }
    });
    render(<TxCreateScreen />);

    expect(screen.getByTestId('tx-total-spend').textContent).toBe('0.00103860 QBT');
    expect(screen.queryByTestId('tx-fee-warning')).toBeNull();
    expect(screen.getByTestId('tx-fee-recommendation-unavailable').textContent).toBe(
      'fee_warning_recommendation_unavailable'
    );
  });
});
