import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useQbitSendPlanReviewScreenLogic } from '@qbit/wallet-state';

import QbitSendPlanReviewScreen from './QbitSendPlanReviewScreen';

vi.mock('@qbit/wallet-state', () => ({ useQbitSendPlanReviewScreenLogic: vi.fn() }));

/** The props the mocked components read. */
type MockProps = {
  children?: ReactNode;
  text?: string;
  title?: string;
  icon?: string;
  color?: string;
  percent?: number;
  disabled?: boolean;
  loading?: boolean;
  backDisabled?: boolean;
  onClick?: () => void;
  onBack?: () => void;
  'data-testid'?: string;
};

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const View = ({ children, 'data-testid': testId }: MockProps) =>
    React.createElement('div', { 'data-testid': testId }, children);
  return {
    Button: ({ text, onClick, disabled, loading, 'data-testid': testId }: MockProps) =>
      React.createElement('button', { onClick, disabled: disabled || loading, 'data-testid': testId }, text),
    Card: View,
    Column: View,
    Content: View,
    Footer: ({ children }: MockProps) => React.createElement('footer', null, children),
    Header: ({ onBack, backDisabled, title }: MockProps) =>
      React.createElement(
        'header',
        null,
        React.createElement('button', { onClick: onBack, disabled: backDisabled, 'data-testid': 'back' }),
        title
      ),
    Layout: View,
    Row: View,
    Text: ({ text, 'data-testid': testId }: MockProps) => React.createElement('span', { 'data-testid': testId }, text)
  };
});

vi.mock('@/ui/components/QbitRestoredFloorWarning', () => ({
  QbitRestoredFloorWarning: ({
    risk,
    checked,
    onChange
  }: {
    risk: { challengeId: string };
    checked: boolean;
    onChange: (checked: boolean) => void;
  }) => (
    <input
      type="checkbox"
      data-testid="restored-floor-warning"
      data-challenge={risk.challengeId}
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
    />
  )
}));

const t = (key: string) => key;

function logic(overrides: Record<string, unknown> = {}) {
  return {
    ready: true,
    t,
    review: {},
    title: 'send_plan_review_title',
    recipient: 'qb1zrecipient',
    receives: '0.01000000 QBT',
    transactions: 'send_plan_steps_many:4',
    totalFee: '0.02000000 QBT',
    change: '',
    signing: 'send_plan_signatures:530 · send_plan_time_minutes:11',
    budget: 'send_plan_review_budget:1,000,1,530',
    note: 'send_plan_review_note',
    revision: undefined,
    restoredFloorRisk: undefined,
    riskAccepted: false,
    onRiskAcceptedChange: vi.fn(),
    unusableText: '',
    planOpenText: '',
    error: '',
    confirming: false,
    canConfirm: true,
    onClickReject: vi.fn(),
    onClickConfirm: vi.fn(),
    onClickViewPlan: vi.fn(),
    ...overrides
  } as unknown as ReturnType<typeof useQbitSendPlanReviewScreenLogic>;
}

function show(value: ReturnType<typeof useQbitSendPlanReviewScreenLogic>) {
  vi.mocked(useQbitSendPlanReviewScreenLogic).mockReturnValue(value);
  return render(<QbitSendPlanReviewScreen />);
}

describe('QbitSendPlanReviewScreen (#188)', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows the whole plan once, with Reject and Confirm pinned below it', () => {
    show(logic({ change: '0.00005000 QBT' }));

    expect(screen.getByTestId('qbit-send-plan-review-recipient').textContent).toBe('qb1zrecipient');
    expect(screen.getByTestId('qbit-send-plan-review-receives').textContent).toBe('0.01000000 QBT');
    expect(screen.getByTestId('qbit-send-plan-review-transactions').textContent).toBe('send_plan_steps_many:4');
    expect(screen.getByTestId('qbit-send-plan-review-total-fee').textContent).toBe('0.02000000 QBT');
    expect(screen.getByTestId('qbit-send-plan-review-change').textContent).toBe('0.00005000 QBT');
    expect(screen.getByTestId('qbit-send-plan-review-signing').textContent).toBe(
      'send_plan_signatures:530 · send_plan_time_minutes:11'
    );
    expect(screen.getByTestId('qbit-send-plan-review-budget').textContent).toBe('send_plan_review_budget:1,000,1,530');
    expect(screen.getByTestId('qbit-send-plan-review-note').textContent).toBe('send_plan_review_note');
    const footer = screen.getByRole('contentinfo');
    expect(footer.contains(screen.getByTestId('qbit-send-plan-review-reject'))).toBe(true);
    expect(footer.contains(screen.getByTestId('qbit-send-plan-review-confirm'))).toBe(true);
    expect(screen.queryByTestId('qbit-send-plan-review-revision')).toBeNull();
    expect(screen.queryByTestId('restored-floor-warning')).toBeNull();
  });

  it('shows no change row when nothing comes back', () => {
    show(logic());
    expect(screen.queryByTestId('qbit-send-plan-review-change')).toBeNull();
  });

  it('confirms and rejects through the hook', () => {
    const onClickConfirm = vi.fn();
    const onClickReject = vi.fn();
    show(logic({ onClickConfirm, onClickReject }));
    fireEvent.click(screen.getByTestId('qbit-send-plan-review-confirm'));
    fireEvent.click(screen.getByTestId('qbit-send-plan-review-reject'));
    expect(onClickConfirm).toHaveBeenCalledTimes(1);
    expect(onClickReject).toHaveBeenCalledTimes(1);
  });

  it('holds both buttons and Back while the plan starts', () => {
    show(logic({ confirming: true, canConfirm: false }));
    expect((screen.getByTestId('qbit-send-plan-review-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('qbit-send-plan-review-reject') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('back') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says what a revision changes', () => {
    show(
      logic({
        revision: {
          title: 'send_plan_revision_title',
          lines: ['send_plan_revision_recipient_unchanged', 'send_plan_revision_amount:0.0098,QBT,0.01,QBT']
        }
      })
    );
    const card = screen.getByTestId('qbit-send-plan-review-revision');
    expect(card.textContent).toContain('send_plan_revision_title');
    expect(screen.getAllByTestId('qbit-send-plan-review-revision-line').map((line) => line.textContent)).toEqual([
      'send_plan_revision_recipient_unchanged',
      'send_plan_revision_amount:0.0098,QBT,0.01,QBT'
    ]);
  });

  it('shows the restored-floor warning, whose acknowledgement the hook needs', () => {
    const onRiskAcceptedChange = vi.fn();
    show(
      logic({
        restoredFloorRisk: {
          recoveryStatus: 'seed-only-restored',
          counterConfidence: 'chain-floor-only',
          knownOnChainSignatures: 3,
          challengeId: 'challenge-2'
        },
        canConfirm: false,
        onRiskAcceptedChange
      })
    );
    const warning = screen.getByTestId('restored-floor-warning');
    expect(warning.getAttribute('data-challenge')).toBe('challenge-2');
    expect((screen.getByTestId('qbit-send-plan-review-confirm') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(warning);
    expect(onRiskAcceptedChange).toHaveBeenCalledWith(true);
  });

  it('says when the review expired', () => {
    show(logic({ unusableText: 'send_plan_review_expired', canConfirm: false }));
    expect(screen.getByTestId('qbit-send-plan-review-stale').textContent).toBe('send_plan_review_expired');
    expect((screen.getByTestId('qbit-send-plan-review-confirm') as HTMLButtonElement).disabled).toBe(true);
  });

  it('links to a payment already in progress', () => {
    const onClickViewPlan = vi.fn();
    show(logic({ planOpenText: 'send_plan_already_open', canConfirm: false, onClickViewPlan }));
    expect(screen.getByTestId('qbit-send-plan-review-plan-open').textContent).toContain('send_plan_already_open');
    fireEvent.click(screen.getByTestId('qbit-send-plan-review-view-plan'));
    expect(onClickViewPlan).toHaveBeenCalledTimes(1);
  });

  it('shows why the start failed', () => {
    show(logic({ error: 'Attempting to use a disconnected port object' }));
    expect(screen.getByTestId('qbit-send-plan-review-error').textContent).toBe(
      'Attempting to use a disconnected port object'
    );
  });

  it('can only be left without a whole review', () => {
    const onClickReject = vi.fn();
    show({ ready: false, t, unavailableText: 'send_plan_review_unavailable', onClickReject });
    expect(screen.getByTestId('qbit-send-plan-review-unavailable').textContent).toBe('send_plan_review_unavailable');
    expect(screen.queryByTestId('qbit-send-plan-review-confirm')).toBeNull();
    fireEvent.click(screen.getByTestId('qbit-send-plan-review-reject'));
    expect(onClickReject).toHaveBeenCalledTimes(1);
  });
});
