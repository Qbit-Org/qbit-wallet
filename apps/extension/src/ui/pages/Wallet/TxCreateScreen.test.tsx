import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useI18n, useTxCreateScreenLogic } from '@qbit/wallet-state';

import TxCreateScreen from './TxCreateScreen';

vi.mock('@qbit/wallet-state', () => ({
  useI18n: vi.fn(),
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

const feeRateBarProps = vi.hoisted(() => ({ quote: undefined as unknown }));
vi.mock('@/ui/components/FeeRateBar', () => ({
  FeeRateBar: ({ headerRight, quote }: any) => {
    feeRateBarProps.quote = quote;
    return <div>fee-rate-bar{headerRight}</div>;
  }
}));
vi.mock('@/ui/components/RBFBar', () => ({ RBFBar: () => null }));

describe('TxCreateScreen fee details', () => {
  const feeQuote = {
    status: 'loaded' as const,
    read: 'read-1',
    summary: { list: [{ title: 'slow', desc: '', feeRate: 1 }] }
  };

  beforeEach(() => {
    feeRateBarProps.quote = undefined;
    vi.mocked(useI18n).mockReturnValue({ locale: 'en' } as ReturnType<typeof useI18n>);
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
      feeEstimatePending: false,
      feeQuote,
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

    expect(screen.getByTestId('tx-size-estimate').textContent).toBe('estimated_inputs_and_size:1,3.8 · 4,000 bits');
    expect(screen.queryByTestId('tx-input-dominance-note')).toBeNull();
    expect(screen.getByTestId('tx-change-drop-note').textContent).toBe('change_below_dust_added_to_fee:183');
    expect(screen.queryByTestId('tx-consolidate-button')).toBeNull();
  });

  it.each([
    ['en', '3.8', '1,544,000'],
    ['es', '3,8', '1.544.000'],
    ['de-DE', '3,8', '1.544.000'],
    ['fr', '3,8', '1\u202f544\u202f000'],
    ['zh_TW', '3.8', '1,544,000']
  ])('formats the size and the fee for the %s locale', (locale, size, fee) => {
    vi.mocked(useI18n).mockReturnValue({ locale } as ReturnType<typeof useI18n>);
    const logic = vi.mocked(useTxCreateScreenLogic)();
    vi.mocked(useTxCreateScreenLogic).mockReturnValue({
      ...logic,
      feeDetail: { ...logic.feeDetail!, estimatedFee: 1_544_000 }
    });
    render(<TxCreateScreen />);

    expect(screen.getByTestId('tx-size-estimate').textContent).toBe(
      `estimated_inputs_and_size:1,${size} · ${fee} bits`
    );
  });

  it.each([
    ['en', '1.0', '4,000'],
    // Spanish groups only from five digits.
    ['es', '1,0', '4000']
  ])('keeps one decimal on a whole size for the %s locale', (locale, size, fee) => {
    vi.mocked(useI18n).mockReturnValue({ locale } as ReturnType<typeof useI18n>);
    const logic = vi.mocked(useTxCreateScreenLogic)();
    vi.mocked(useTxCreateScreenLogic).mockReturnValue({
      ...logic,
      feeDetail: { ...logic.feeDetail!, estimatedVsize: 1_000 }
    });
    render(<TxCreateScreen />);

    expect(screen.getByTestId('tx-size-estimate').textContent).toBe(
      `estimated_inputs_and_size:1,${size} · ${fee} bits`
    );
  });

  it('builds the size and fee formats once for the locale, with its Intl tag, across renders', () => {
    vi.mocked(useI18n).mockReturnValue({ locale: 'zh_TW' } as ReturnType<typeof useI18n>);
    const numberFormat = vi.spyOn(Intl, 'NumberFormat');
    try {
      const { rerender } = render(<TxCreateScreen />);
      rerender(<TxCreateScreen />);

      expect(numberFormat).toHaveBeenCalledTimes(2);
      expect(numberFormat.mock.calls.map(([locale]) => locale)).toEqual(['zh-TW', 'zh-TW']);
    } finally {
      numberFormat.mockRestore();
    }
  });

  it('shows the fee and the total as pending until the fee rate is settled', () => {
    vi.mocked(useTxCreateScreenLogic).mockReturnValue({
      ...vi.mocked(useTxCreateScreenLogic)(),
      feeDetail: undefined,
      feeEstimatePending: true,
      spendSummary: { totalSpend: '--', feeWarnings: [] }
    });
    render(<TxCreateScreen />);

    // Through the same translation as the settled estimate.
    expect(screen.getByTestId('tx-fee-estimate-pending').textContent).toBe('estimated_inputs_and_size:--,-- · -- bits');
    // Not the estimate a reader waits for.
    expect(screen.queryByTestId('tx-size-estimate')).toBeNull();
    expect(screen.getByTestId('tx-total-spend').textContent).toBe('-- QBT');
    expect(screen.queryByTestId('tx-change-drop-note')).toBeNull();
    expect(screen.queryByTestId('tx-fee-warning')).toBeNull();
  });

  it('gives the fee bar the quote its fee check uses', () => {
    render(<TxCreateScreen />);

    expect(feeRateBarProps.quote).toBe(feeQuote);
  });

  it('offers consolidation for an account over the explorer limit (#277)', () => {
    const onClickConsolidate = vi.fn();
    vi.mocked(useTxCreateScreenLogic).mockReturnValue({
      ...vi.mocked(useTxCreateScreenLogic)(),
      showConsolidate: true,
      consolidationNote: 'consolidation_send_note',
      onClickConsolidate
    });
    render(<TxCreateScreen />);

    expect(screen.getByTestId('consolidation-send-note').textContent).toBe('consolidation_send_note');
    fireEvent.click(screen.getByTestId('tx-consolidate-button'));
    expect(onClickConsolidate).toHaveBeenCalledTimes(1);
  });

  it('drops the consolidation note once the account cannot send (#169)', () => {
    vi.mocked(useTxCreateScreenLogic).mockReturnValue({
      ...vi.mocked(useTxCreateScreenLogic)(),
      error: 'utxo_limit_exceeded_send',
      showConsolidate: true,
      consolidationNote: ''
    });
    render(<TxCreateScreen />);

    expect(screen.getByTestId('tx-create-error').textContent).toBe('utxo_limit_exceeded_send');
    expect(screen.queryByTestId('consolidation-send-note')).toBeNull();
    expect(screen.getByTestId('tx-consolidate-button')).toBeTruthy();
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

  it('says what a payment one transaction cannot carry will take (#188)', () => {
    vi.mocked(useTxCreateScreenLogic).mockReturnValue({
      ...vi.mocked(useTxCreateScreenLogic)(),
      sendPlanNotice: {
        title: 'send_plan_notice_title_everything:5',
        steps: 'send_plan_steps_many:4',
        receives: '0.12345678 QBT',
        totalFee: '0.01994135 QBT',
        signing: 'send_plan_signatures:504 · send_plan_time_minutes:11',
        leftBehind: 'send_plan_left_behind:0.00006000,QBT',
        unconfirmed: 'send_plan_unconfirmed_not_included:0.00050000,QBT'
      }
    });
    render(<TxCreateScreen />);

    const notice = screen.getByTestId('tx-send-plan-notice');
    expect(screen.getByTestId('tx-send-plan-title').textContent).toBe('send_plan_notice_title_everything:5');
    expect(screen.getByTestId('tx-send-plan-steps').textContent).toBe('send_plan_steps_many:4');
    expect(screen.getByTestId('tx-send-plan-receives').textContent).toBe('0.12345678 QBT');
    expect(screen.getByTestId('tx-send-plan-total-fee').textContent).toBe('0.01994135 QBT');
    expect(screen.getByTestId('tx-send-plan-signing').textContent).toBe(
      'send_plan_signatures:504 · send_plan_time_minutes:11'
    );
    expect(screen.getByTestId('tx-send-plan-left-behind').textContent).toBe('send_plan_left_behind:0.00006000,QBT');
    expect(screen.getByTestId('tx-send-plan-unconfirmed-not-included').textContent).toBe(
      'send_plan_unconfirmed_not_included:0.00050000,QBT'
    );
    expect(notice.textContent).toContain('send_plan_receives');
    expect(notice.textContent).toContain('send_plan_total_fee');
    expect(screen.queryByTestId('tx-create-error')).toBeNull();
    expect(screen.queryByTestId('tx-send-plan-refusal')).toBeNull();
    // The notice comes before Next, which stays below it on the same screen.
    expect(
      notice.compareDocumentPosition(screen.getByTestId('tx-next-button')) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('offers the largest amount that can be sent as a choice, never in place of the one typed (#188)', () => {
    const onClickMaxSendable = vi.fn();
    vi.mocked(useTxCreateScreenLogic).mockReturnValue({
      ...vi.mocked(useTxCreateScreenLogic)(),
      disabled: true,
      sendPlanRefusal: {
        message: 'send_plan_short_of_fees',
        offerText: 'send_plan_max_sendable:0.00931828,QBT',
        offerButtonText: 'send_plan_use_max_sendable:0.00931828,QBT',
        unconfirmedText: 'send_plan_unconfirmed_note:0.00008000,QBT'
      },
      onClickMaxSendable
    });
    render(<TxCreateScreen />);

    expect(screen.getByTestId('tx-send-plan-refusal-message').textContent).toBe('send_plan_short_of_fees');
    expect(screen.getByTestId('tx-send-plan-offer').textContent).toBe('send_plan_max_sendable:0.00931828,QBT');
    expect(screen.getByTestId('tx-send-plan-unconfirmed').textContent).toBe(
      'send_plan_unconfirmed_note:0.00008000,QBT'
    );
    expect(onClickMaxSendable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('tx-send-plan-max-sendable'));
    expect(onClickMaxSendable).toHaveBeenCalledTimes(1);
  });

  it('puts the largest amount that can be sent right under the amount, above the fee and Next (#188)', () => {
    vi.mocked(useTxCreateScreenLogic).mockReturnValue({
      ...vi.mocked(useTxCreateScreenLogic)(),
      disabled: true,
      sendPlanRefusal: {
        message: 'send_plan_short_of_fees',
        offerText: 'send_plan_max_sendable:0.00931828,QBT',
        offerButtonText: 'send_plan_use_max_sendable:0.00931828,QBT',
        unconfirmedText: ''
      }
    });
    render(<TxCreateScreen />);

    // At 357 x 600 only what comes this early shows without scrolling; the
    // test environment lays nothing out, so the order is what is checked.
    const follows = (earlier: Element, later: Element) =>
      Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
    const amount = screen.getByTestId('transfer-amount-input');
    const refusal = screen.getByTestId('tx-send-plan-refusal');
    const offerButton = screen.getByTestId('tx-send-plan-max-sendable');
    expect(refusal.contains(offerButton)).toBe(true);
    expect(follows(amount, refusal)).toBe(true);
    for (const later of [
      screen.getByText('available'),
      screen.getByText('fee-rate-bar'),
      screen.getByTestId('tx-next-button')
    ]) {
      expect(follows(offerButton, later)).toBe(true);
    }
  });

  it('offers no amount when there is none to send (#188)', () => {
    vi.mocked(useTxCreateScreenLogic).mockReturnValue({
      ...vi.mocked(useTxCreateScreenLogic)(),
      sendPlanRefusal: {
        message: 'send_plan_nothing_to_send',
        offerText: '',
        offerButtonText: '',
        unconfirmedText: ''
      }
    });
    render(<TxCreateScreen />);
    expect(screen.getByTestId('tx-send-plan-refusal-message').textContent).toBe('send_plan_nothing_to_send');
    expect(screen.queryByTestId('tx-send-plan-max-sendable')).toBeNull();
    expect(screen.queryByTestId('tx-send-plan-offer')).toBeNull();
  });

  it('links to the payment already in progress (#188)', () => {
    const onClickViewSendPlan = vi.fn();
    vi.mocked(useTxCreateScreenLogic).mockReturnValue({
      ...vi.mocked(useTxCreateScreenLogic)(),
      sendPlanOpenText: 'send_plan_already_open',
      onClickViewSendPlan
    });
    render(<TxCreateScreen />);
    expect(screen.getByTestId('tx-send-plan-open').textContent).toContain('send_plan_already_open');
    fireEvent.click(screen.getByTestId('tx-send-plan-open-link'));
    expect(onClickViewSendPlan).toHaveBeenCalledTimes(1);
  });

  it('says what MAX leaves while another payment is in progress, and links to that payment (#188)', () => {
    const onClickViewSendPlan = vi.fn();
    vi.mocked(useTxCreateScreenLogic).mockReturnValue({
      ...vi.mocked(useTxCreateScreenLogic)(),
      leftBehindNote: 'send_all_leaves_outputs_behind:106,0.00440000,QBT,44',
      sendPlanOpenText: 'send_plan_open_holds_rest',
      onClickViewSendPlan
    });
    render(<TxCreateScreen />);
    expect(screen.getByTestId('tx-left-behind-note').textContent).toBe(
      'send_all_leaves_outputs_behind:106,0.00440000,QBT,44'
    );
    expect(screen.getByTestId('tx-send-plan-open').textContent).toContain('send_plan_open_holds_rest');
    expect(screen.queryByTestId('tx-send-plan-notice')).toBeNull();
    fireEvent.click(screen.getByTestId('tx-send-plan-open-link'));
    expect(onClickViewSendPlan).toHaveBeenCalledTimes(1);
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
