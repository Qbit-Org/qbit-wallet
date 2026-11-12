import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type {
  QbitSendPlanAction,
  QbitSendPlanPauseReason,
  QbitSendPlanStepStatus,
  QbitSendPlanView
} from '@qbit/wallet-shared';
import { useQbitSendPlanScreenLogic } from '@qbit/wallet-state';

import QbitSendPlanScreen from './QbitSendPlanScreen';

vi.mock('@qbit/wallet-state', () => ({ useQbitSendPlanScreenLogic: vi.fn() }));

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
      React.createElement(
        'button',
        { onClick, disabled: disabled || loading, 'data-testid': testId, 'data-loading': loading ? 'true' : undefined },
        text
      ),
    Card: View,
    Column: View,
    Content: View,
    Footer: ({ children }: MockProps) => React.createElement('footer', null, children),
    Header: ({ onBack, title }: MockProps) =>
      React.createElement(
        'header',
        null,
        React.createElement('button', { onClick: onBack, 'data-testid': 'back' }),
        title
      ),
    Icon: ({ icon, 'data-testid': testId }: MockProps) =>
      React.createElement('i', { 'data-icon': icon, 'data-testid': testId }),
    Layout: View,
    Progress: ({ percent, 'data-testid': testId }: MockProps) =>
      React.createElement('div', { 'data-testid': testId, 'data-percent': String(percent) }),
    Row: ({ children, onClick, 'data-testid': testId }: MockProps) =>
      React.createElement('div', { onClick, 'data-testid': testId }, children),
    Text: ({ text, 'data-testid': testId }: MockProps) => React.createElement('span', { 'data-testid': testId }, text)
  };
});

vi.mock('@/ui/components/FeeRateBar', () => ({
  FeeRateBar: ({ quote }: { quote: unknown }) => <div data-testid="fee-rate-bar" data-quote={JSON.stringify(quote)} />
}));
vi.mock('@/ui/components/Popover', () => ({
  Popover: ({ children, 'data-testid': testId }: MockProps) => <div data-testid={testId}>{children}</div>
}));

// The copy the hook gives each pause, and where it says the funds are.
let copy: typeof import('../../../../../../packages/wallet-state/src/utils/qbit-send-plan');
beforeAll(async () => {
  copy = await vi.importActual<typeof import('../../../../../../packages/wallet-state/src/utils/qbit-send-plan')>(
    '../../../../../../packages/wallet-state/src/utils/qbit-send-plan'
  );
});

const t = (key: string, substitutions?: string | string[]) =>
  substitutions === undefined ? key : `${key}:${([] as string[]).concat(substitutions).join(',')}`;

function plan(overrides: Partial<QbitSendPlanView> = {}): QbitSendPlanView {
  return {
    id: 'plan-1',
    chain: 'QBIT_MAINNET' as QbitSendPlanView['chain'],
    address: 'qb1zaccount',
    recipient: 'qb1zrecipient000000000000000000000000000000000000000000000',
    target: 'amount',
    amount: 1_000_000,
    change: 0,
    feeRate: 1,
    totalFee: 588_827,
    steps: [
      { kind: 'merge', txid: 'aa'.repeat(32), inputCount: 106, fee: 398_827, status: 'planned' },
      { kind: 'payment', txid: 'bb'.repeat(32), inputCount: 50, fee: 190_000, status: 'planned' }
    ],
    sent: false,
    phase: 'signing',
    actions: ['cancel'],
    signaturesDone: 40,
    signaturesTotal: 156,
    paymentTxid: 'bb'.repeat(32),
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    ...overrides
  };
}

function logic(view: QbitSendPlanView, overrides: Record<string, unknown> = {}) {
  const buttons = view.actions.map((action: QbitSendPlanAction, index) => ({
    action,
    text: `action:${action}`,
    primary: index === 0 && action !== 'cancel',
    onClick: vi.fn()
  }));
  return {
    ready: true,
    t,
    plan: view,
    readFailedText: '',
    title: 'send_plan_header',
    amount: '0.01000000 QBT',
    recipient: view.recipient,
    fee: 'send_plan_fee_summary:0.00588827,QBT,1',
    stages: [
      { key: 'signing', label: 'send_plan_stage_signing', state: view.phase === 'signing' ? 'active' : 'done' },
      {
        key: 'combining',
        label: 'send_plan_stage_combining',
        state: 'pending',
        detail: 'send_plan_combine_progress:0,1'
      },
      { key: 'paying', label: 'send_plan_stage_paying', state: 'pending' },
      { key: 'done', label: 'send_plan_stage_done', state: 'pending' }
    ],
    signing: undefined,
    note: '',
    slowMerge: '',
    pause:
      view.phase === 'paused'
        ? {
            ...copy.qbitSendPlanPauseCopy(view, t),
            next: copy.qbitSendPlanMayConfirmNext(view, t),
            funds: copy.qbitSendPlanFundsText(view, t),
            detail: view.pause?.detail ?? ''
          }
        : undefined,
    mayConfirm:
      view.phase !== 'paused' && copy.qbitSendPlanPaymentMayConfirm(view)
        ? {
            title: t('send_plan_may_confirm_title'),
            body: t('send_plan_may_confirm_body'),
            next: copy.qbitSendPlanMayConfirmNext(view, t),
            funds: copy.qbitSendPlanFundsText(view, t)
          }
        : undefined,
    cancelling: undefined,
    buttons,
    busy: null,
    actionError: '',
    raiseDialog: undefined,
    cancelDialog: undefined,
    onClickBack: vi.fn(),
    ...overrides
  } as unknown as ReturnType<typeof useQbitSendPlanScreenLogic>;
}

function waiting(fields: { loading: boolean; readFailedText: string; onClickBack: () => void }) {
  return { ready: false, t, ...fields } as ReturnType<typeof useQbitSendPlanScreenLogic>;
}

function show(value: ReturnType<typeof useQbitSendPlanScreenLogic>) {
  vi.mocked(useQbitSendPlanScreenLogic).mockReturnValue(value);
  return render(<QbitSendPlanScreen />);
}

const actionButtons = () =>
  screen
    .queryAllByRole('button')
    .map((button) => button.getAttribute('data-testid'))
    .filter((testId) => testId?.startsWith('qbit-send-plan-action-'));

describe('QbitSendPlanScreen (#188)', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows signing: how far, the transaction, the time left, and that the window can close', () => {
    show(
      logic(plan(), {
        signing: {
          percent: 25.6,
          count: 'send_plan_signatures_progress:40,156',
          transaction: 'signing_progress_transaction:1,2',
          timeLeft: 'signing_progress_minutes_left:2'
        },
        note: 'send_plan_signing_close_note'
      })
    );

    expect(screen.getByTestId('qbit-send-plan-state').getAttribute('data-phase')).toBe('signing');
    expect(screen.getByTestId('qbit-send-plan-amount').textContent).toBe('0.01000000 QBT');
    expect(screen.getByText('send_plan_to:qb1zreci...00000000')).toBeTruthy();
    expect(screen.getByTestId('qbit-send-plan-fee').textContent).toBe('send_plan_fee_summary:0.00588827,QBT,1');
    expect(screen.getByTestId('qbit-send-plan-signing-bar').getAttribute('data-percent')).toBe('25.6');
    expect(screen.getByTestId('qbit-send-plan-signing-count').textContent).toBe('send_plan_signatures_progress:40,156');
    expect(screen.getByTestId('qbit-send-plan-signing-transaction').textContent).toBe(
      'signing_progress_transaction:1,2'
    );
    expect(screen.getByTestId('qbit-send-plan-time-left').textContent).toBe('signing_progress_minutes_left:2');
    expect(screen.getByTestId('qbit-send-plan-note').textContent).toBe('send_plan_signing_close_note');
    expect(screen.getByTestId('qbit-send-plan-stage-signing-state').getAttribute('data-state')).toBe('active');
    expect(screen.getByTestId('qbit-send-plan-stage-combining').textContent).toContain(
      'send_plan_combine_progress:0,1'
    );
    expect(screen.queryByTestId('qbit-send-plan-paused')).toBeNull();
    expect(actionButtons()).toEqual(['qbit-send-plan-action-cancel']);
  });

  it('shows the funds combining while it waits, and a slow one', () => {
    show(
      logic(plan({ phase: 'waiting', slowMerge: true, actions: ['raise_merge_fee', 'cancel'] }), {
        note: 'send_plan_waiting_note',
        slowMerge: 'send_plan_slow_merge'
      })
    );
    expect(screen.getByTestId('qbit-send-plan-state').getAttribute('data-phase')).toBe('waiting');
    expect(screen.queryByTestId('qbit-send-plan-signing-bar')).toBeNull();
    expect(screen.getByTestId('qbit-send-plan-note').textContent).toBe('send_plan_waiting_note');
    expect(screen.getByTestId('qbit-send-plan-slow-merge').textContent).toBe('send_plan_slow_merge');
    expect(actionButtons()).toEqual(['qbit-send-plan-action-raise_merge_fee', 'qbit-send-plan-action-cancel']);
  });

  it('shows the payment going out with nothing to do', () => {
    show(logic(plan({ phase: 'sending', actions: [] })));
    expect(screen.getByTestId('qbit-send-plan-state').getAttribute('data-phase')).toBe('sending');
    expect(actionButtons()).toEqual([]);
    expect(screen.queryByRole('contentinfo')).toBeNull();
  });

  it('says the wallet checks one transaction while it cancels, and where the funds are', () => {
    show(
      logic(plan({ phase: 'cancelling', actions: [] }), {
        cancelling: {
          title: 'send_plan_cancelling_title',
          body: 'send_plan_cancelling_body',
          funds: 'send_plan_funds_partly_combined'
        }
      })
    );
    const card = screen.getByTestId('qbit-send-plan-cancelling');
    expect(card.textContent).toContain('send_plan_cancelling_title');
    expect(card.textContent).toContain('send_plan_cancelling_body');
    expect(screen.getByTestId('qbit-send-plan-funds').textContent).toBe('send_plan_funds_partly_combined');
    expect(actionButtons()).toEqual([]);
  });

  it.each<[QbitSendPlanPauseReason, QbitSendPlanStepStatus, QbitSendPlanAction[], string]>([
    ['locked', 'planned', ['cancel'], 'send_plan_funds_untouched'],
    ['interrupted', 'broadcast', ['continue', 'cancel'], 'send_plan_funds_partly_combined'],
    ['merge_refused', 'unknown', ['replan', 'cancel'], 'send_plan_funds_partly_combined'],
    ['outputs_spent', 'confirmed', ['replan', 'cancel'], 'send_plan_funds_combined'],
    ['payment_fee_too_low', 'confirmed', ['raise_payment_fee', 'cancel'], 'send_plan_funds_combined'],
    ['payment_refused', 'confirmed', ['replan', 'cancel'], 'send_plan_funds_combined']
  ])(
    'shows the %s pause with its own copy, where the funds are, and only its actions',
    (reason, status, actions, funds) => {
      const view = plan({
        phase: 'paused',
        pause: { reason, detail: 'detail of the refusal' },
        actions,
        steps: [
          { kind: 'merge', txid: 'aa'.repeat(32), inputCount: 106, fee: 398_827, status },
          { kind: 'payment', txid: 'bb'.repeat(32), inputCount: 50, fee: 190_000, status: 'signed' }
        ],
        sent: status !== 'planned'
      });
      show(logic(view));

      expect(screen.getByTestId('qbit-send-plan-state').getAttribute('data-reason')).toBe(reason);
      expect(screen.getByTestId('qbit-send-plan-paused-title').textContent).toBe(`send_plan_paused_${reason}`);
      expect(screen.getByTestId('qbit-send-plan-paused-body').textContent).toBe(`send_plan_paused_${reason}_body`);
      expect(screen.getByTestId('qbit-send-plan-funds').textContent).toBe(funds);
      expect(actionButtons()).toEqual(actions.map((action) => `qbit-send-plan-action-${action}`));
      // The detail stays folded until asked for.
      expect(screen.queryByTestId('qbit-send-plan-details')).toBeNull();
      fireEvent.click(screen.getByTestId('qbit-send-plan-details-toggle'));
      expect(screen.getByTestId('qbit-send-plan-details').textContent).toBe('detail of the refusal');
    }
  );

  it('shows the recipient, the amount and the total fee before Continue, ahead of the pause and the stages (#188)', () => {
    // After a restart signing waits for Continue: the terms the user
    // confirmed come first, so they show without scrolling at 357 x 600,
    // and Continue is pinned in the footer. The test environment lays
    // nothing out, so the order is what is checked.
    show(logic(plan({ phase: 'paused', pause: { reason: 'interrupted' }, actions: ['continue', 'cancel'] })));

    const follows = (earlier: Element, later: Element) =>
      Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
    const amount = screen.getByTestId('qbit-send-plan-amount');
    const recipient = screen.getByText('send_plan_to:qb1zreci...00000000');
    const fee = screen.getByTestId('qbit-send-plan-fee');
    expect(fee.textContent).toBe('send_plan_fee_summary:0.00588827,QBT,1');
    expect(follows(amount, recipient)).toBe(true);
    expect(follows(recipient, fee)).toBe(true);
    for (const later of [screen.getByTestId('qbit-send-plan-paused'), screen.getByTestId('qbit-send-plan-stages')]) {
      expect(follows(fee, later)).toBe(true);
    }
    const footer = screen.getByRole('contentinfo');
    expect(footer.contains(screen.getByTestId('qbit-send-plan-action-continue'))).toBe(true);
    expect(footer.contains(fee)).toBe(false);
  });

  // A version of the payment left the wallet without an answer and may still
  // confirm: whatever the plan paused for, the card says that, and nothing
  // says the payment was not sent, that nothing was sent, or offers a cancel.
  const NOT_SENT = /send_plan_funds_|send_plan_paused_\w+_body|send_plan_cancel|send_plan_action_cancel|send_plan_action_replan/;

  it.each<[QbitSendPlanPauseReason, QbitSendPlanAction[], string]>([
    ['locked', [], ''],
    ['interrupted', ['continue'], 'send_plan_may_confirm_continue'],
    ['merge_refused', ['continue'], 'send_plan_may_confirm_continue'],
    ['outputs_spent', ['continue'], 'send_plan_may_confirm_continue'],
    ['payment_fee_too_low', ['raise_payment_fee', 'continue'], 'send_plan_may_confirm_raise_or_continue'],
    ['payment_refused', ['continue'], 'send_plan_may_confirm_continue']
  ])(
    'says the %s pause may still go through when a version of the payment may confirm, with only its actions (#188)',
    (reason, actions, next) => {
      const view = plan({
        phase: 'paused',
        pause: { reason, detail: 'detail of the refusal' },
        actions,
        steps: [
          { kind: 'merge', txid: 'aa'.repeat(32), inputCount: 106, fee: 398_827, status: 'confirmed' },
          { kind: 'payment', txid: 'bb'.repeat(32), inputCount: 50, fee: 190_000, status: 'signed' }
        ],
        sent: true,
        paymentMayConfirm: true
      });
      show(logic(view));

      expect(screen.getByTestId('qbit-send-plan-state').getAttribute('data-reason')).toBe(reason);
      expect(screen.getByTestId('qbit-send-plan-paused-title').textContent).toBe('send_plan_may_confirm_title');
      expect(screen.getByTestId('qbit-send-plan-paused-body').textContent).toBe('send_plan_may_confirm_body');
      if (next) expect(screen.getByTestId('qbit-send-plan-paused-next').textContent).toBe(next);
      else expect(screen.queryByTestId('qbit-send-plan-paused-next')).toBeNull();
      expect(screen.getByTestId('qbit-send-plan-funds').textContent).toBe('send_plan_may_confirm_funds_combined');
      expect(actionButtons()).toEqual(actions.map((action) => `qbit-send-plan-action-${action}`));
      expect(document.body.textContent).not.toMatch(NOT_SENT);
      // The terms the user confirmed come first, then the card, then the stages.
      const follows = (earlier: Element, later: Element) =>
        Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
      const card = screen.getByTestId('qbit-send-plan-paused');
      expect(follows(screen.getByTestId('qbit-send-plan-fee'), card)).toBe(true);
      expect(follows(card, screen.getByTestId('qbit-send-plan-stages'))).toBe(true);
    }
  );

  it.each<QbitSendPlanView['phase']>(['signing', 'waiting', 'sending'])(
    'says the payment may still go through while %s, where nothing is paused (#188)',
    (phase) => {
      show(
        logic(
          plan({
            phase,
            actions: [],
            steps: [
              { kind: 'merge', txid: 'aa'.repeat(32), inputCount: 106, fee: 398_827, status: 'broadcast' },
              { kind: 'payment', txid: 'bb'.repeat(32), inputCount: 50, fee: 190_000, status: 'signed' }
            ],
            sent: true,
            paymentMayConfirm: true
          })
        )
      );
      expect(screen.queryByTestId('qbit-send-plan-paused')).toBeNull();
      expect(screen.getByTestId('qbit-send-plan-may-confirm-title').textContent).toBe('send_plan_may_confirm_title');
      expect(screen.getByTestId('qbit-send-plan-may-confirm-body').textContent).toBe('send_plan_may_confirm_body');
      expect(screen.queryByTestId('qbit-send-plan-may-confirm-next')).toBeNull();
      expect(screen.getByTestId('qbit-send-plan-funds').textContent).toBe(
        'send_plan_may_confirm_funds_partly_combined'
      );
      expect(actionButtons()).toEqual([]);
      expect(document.body.textContent).not.toMatch(NOT_SENT);
    }
  );

  it('shows no such card for a plan no version of whose payment may still confirm', () => {
    show(logic(plan({ phase: 'waiting', actions: ['cancel'], sent: true })));
    expect(screen.queryByTestId('qbit-send-plan-may-confirm')).toBeNull();
  });

  it('shows a stored payment the wallet cannot read without an amount, a recipient or stages', () => {
    // The background's stand-in: no recipient, amount or rate, and cancel only.
    const view = plan({
      recipient: '',
      amount: 0,
      feeRate: 0,
      totalFee: 0,
      steps: [],
      phase: 'paused',
      pause: { reason: 'unreadable' },
      actions: ['cancel'],
      signaturesDone: 0,
      signaturesTotal: 0,
      paymentTxid: ''
    });
    show(
      logic(view, {
        amount: '',
        recipient: '',
        fee: '',
        stages: [],
        pause: {
          title: 'send_plan_paused_unreadable',
          body: 'send_plan_paused_unreadable_body',
          funds: '',
          detail: ''
        }
      })
    );

    expect(screen.getByTestId('qbit-send-plan-state').getAttribute('data-reason')).toBe('unreadable');
    expect(screen.getByTestId('qbit-send-plan-paused-title').textContent).toBe('send_plan_paused_unreadable');
    expect(screen.getByTestId('qbit-send-plan-paused-body').textContent).toBe('send_plan_paused_unreadable_body');
    expect(screen.queryByTestId('qbit-send-plan-amount')).toBeNull();
    expect(screen.queryByText(/send_plan_to/)).toBeNull();
    expect(screen.queryByTestId('qbit-send-plan-fee')).toBeNull();
    expect(screen.queryByTestId('qbit-send-plan-stages')).toBeNull();
    expect(screen.queryByTestId('qbit-send-plan-funds')).toBeNull();
    expect(actionButtons()).toEqual(['qbit-send-plan-action-cancel']);
  });

  it('shows the primary action in full and the others compact in one row (#188)', () => {
    // A refusal without a reason offers every action; the plan's state above must stay in view.
    const view = plan({
      phase: 'paused',
      pause: { reason: 'payment_refused' },
      actions: ['raise_payment_fee', 'continue', 'replan', 'cancel']
    });
    show(
      logic(view, {
        pause: {
          title: 'send_plan_paused_payment_refused_unexplained',
          body: 'send_plan_paused_payment_refused_unexplained_body',
          funds: 'send_plan_funds_combined',
          detail: ''
        }
      })
    );

    expect(screen.getByTestId('qbit-send-plan-paused-title').textContent).toBe(
      'send_plan_paused_payment_refused_unexplained'
    );
    expect(actionButtons()).toEqual([
      'qbit-send-plan-action-raise_payment_fee',
      'qbit-send-plan-action-continue',
      'qbit-send-plan-action-replan',
      'qbit-send-plan-action-cancel'
    ]);
    const more = screen.getByTestId('qbit-send-plan-more-actions');
    expect(more.contains(screen.getByTestId('qbit-send-plan-action-raise_payment_fee'))).toBe(false);
    for (const action of ['continue', 'replan', 'cancel']) {
      expect(more.contains(screen.getByTestId(`qbit-send-plan-action-${action}`))).toBe(true);
    }
  });

  it('lists the actions in full when none is primary', () => {
    show(logic(plan({ phase: 'paused', pause: { reason: 'locked' }, actions: ['cancel'] })));
    expect(actionButtons()).toEqual(['qbit-send-plan-action-cancel']);
    expect(screen.queryByTestId('qbit-send-plan-more-actions')).toBeNull();
  });

  it('runs the action its button names', () => {
    const value = logic(plan({ phase: 'paused', pause: { reason: 'interrupted' }, actions: ['continue', 'cancel'] }));
    show(value);
    fireEvent.click(screen.getByTestId('qbit-send-plan-action-continue'));
    const buttons = value.ready ? value.buttons : [];
    expect(buttons.map((button) => vi.mocked(button.onClick).mock.calls.length)).toEqual([1, 0]);
  });

  it('holds every button while an action runs', () => {
    show(
      logic(plan({ phase: 'paused', pause: { reason: 'interrupted' }, actions: ['continue', 'cancel'] }), {
        busy: 'continue'
      })
    );
    expect(screen.getByTestId('qbit-send-plan-action-continue').getAttribute('data-loading')).toBe('true');
    expect((screen.getByTestId('qbit-send-plan-action-cancel') as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks before cancelling, saying what cancelling does', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    show(
      logic(plan(), {
        cancelDialog: {
          title: 'send_plan_cancel_title',
          body: 'send_plan_cancel_body',
          keepText: 'send_plan_cancel_keep',
          confirmText: 'send_plan_action_cancel',
          onConfirm,
          onClose
        }
      })
    );
    expect(screen.getByTestId('qbit-send-plan-cancel-body').textContent).toBe('send_plan_cancel_body');
    fireEvent.click(screen.getByTestId('qbit-send-plan-cancel-keep'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('qbit-send-plan-cancel-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('chooses a higher fee rate in the fee bar before reviewing', () => {
    const onReview = vi.fn();
    const feeQuote = { status: 'loaded', read: 'r1' };
    show(
      logic(plan({ phase: 'paused', pause: { reason: 'payment_fee_too_low' }, actions: ['raise_payment_fee'] }), {
        raiseDialog: {
          title: 'send_plan_raise_title',
          body: 'send_plan_raise_body:1',
          feeQuote,
          error: '',
          canReview: false,
          reviewText: 'next',
          closeText: 'back',
          onReview,
          onClose: vi.fn()
        }
      })
    );
    expect(screen.getByTestId('qbit-send-plan-raise-dialog').textContent).toContain('send_plan_raise_body:1');
    expect(screen.getByTestId('fee-rate-bar').getAttribute('data-quote')).toBe(JSON.stringify(feeQuote));
    expect((screen.getByTestId('qbit-send-plan-raise-review') as HTMLButtonElement).disabled).toBe(true);
  });

  it('chooses the rate of a new plan for the same payment before reviewing (#188)', () => {
    const onReview = vi.fn();
    const onClose = vi.fn();
    const feeQuote = { status: 'loaded', read: 'r1' };
    show(
      logic(plan({ phase: 'paused', pause: { reason: 'merge_refused' }, actions: ['replan', 'cancel'] }), {
        replanDialog: {
          title: 'send_plan_replan_title',
          body: 'send_plan_replan_body:2.5',
          feeQuote,
          error: '',
          canReview: true,
          reviewText: 'next',
          closeText: 'back',
          onReview,
          onClose
        }
      })
    );
    const dialog = screen.getByTestId('qbit-send-plan-replan-dialog');
    expect(dialog.textContent).toContain('send_plan_replan_title');
    expect(dialog.textContent).toContain('send_plan_replan_body:2.5');
    expect(screen.getByTestId('fee-rate-bar').getAttribute('data-quote')).toBe(JSON.stringify(feeQuote));
    expect(screen.queryByTestId('qbit-send-plan-raise-dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('qbit-send-plan-replan-review'));
    expect(onReview).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('qbit-send-plan-replan-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows a failed action', () => {
    show(logic(plan(), { actionError: 'The wallet is locked.' }));
    expect(screen.getByTestId('qbit-send-plan-error').textContent).toBe('The wallet is locked.');
  });

  it('goes home from Back', () => {
    const onClickBack = vi.fn();
    show(logic(plan(), { onClickBack }));
    fireEvent.click(screen.getByTestId('back'));
    expect(onClickBack).toHaveBeenCalledTimes(1);
  });

  it('waits for the plan, and says when it cannot be read', () => {
    const onClickBack = vi.fn();
    show(waiting({ loading: true, readFailedText: '', onClickBack }));
    expect(screen.getByTestId('qbit-send-plan-loading')).toBeTruthy();
    cleanup();

    show(waiting({ loading: false, readFailedText: 'send_plan_read_failed', onClickBack }));
    expect(screen.getByTestId('qbit-send-plan-read-failed').textContent).toBe('send_plan_read_failed');
    fireEvent.click(screen.getByTestId('back'));
    expect(onClickBack).toHaveBeenCalledTimes(1);
  });
});
