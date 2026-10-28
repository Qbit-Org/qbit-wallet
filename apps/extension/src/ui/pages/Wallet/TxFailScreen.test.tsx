import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useTxFailScreenLogic } from '@qbit/wallet-state';

import TxFailScreen from './TxFailScreen';

vi.mock('@qbit/wallet-state', () => ({
  useTxFailScreenLogic: vi.fn()
}));

vi.mock('@/ui/utils', () => ({
  shortAddress: (value: string) => `${value.slice(0, 6)}...${value.slice(-6)}`
}));

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children, 'data-testid': dataTestId }: { children?: ReactNode; 'data-testid'?: string }) =>
    React.createElement('div', { 'data-testid': dataTestId }, children);
  const Clickable = ({
    children,
    onClick,
    'data-testid': dataTestId
  }: {
    children?: ReactNode;
    onClick?: () => void;
    'data-testid'?: string;
  }) => React.createElement('div', { onClick, 'data-testid': dataTestId }, children);
  const Button = ({
    text,
    disabled,
    loading,
    onClick,
    'data-testid': dataTestId
  }: {
    text?: string;
    disabled?: boolean;
    loading?: boolean;
    onClick?: () => void;
    'data-testid'?: string;
  }) =>
    React.createElement(
      'button',
      { disabled: disabled || loading, 'data-loading': loading ? 'true' : 'false', onClick, 'data-testid': dataTestId },
      text
    );
  // Mirrors the real Header: a disabled back arrow drops its click handler.
  const Header = ({ onBack, backDisabled }: { onBack?: () => void; backDisabled?: boolean }) =>
    onBack
      ? React.createElement(
          'button',
          { onClick: backDisabled ? undefined : onBack, disabled: backDisabled, 'data-testid': 'header-back-button' },
          'back'
        )
      : null;
  const Icon = ({ icon }: { icon?: string }) => React.createElement('span', { 'data-icon': icon });
  const Text = ({ text, 'data-testid': dataTestId }: { text?: string; 'data-testid'?: string }) =>
    React.createElement('span', { 'data-testid': dataTestId }, text);

  return {
    Button,
    Card: Container,
    Column: Container,
    Content: Container,
    Footer: Container,
    Header,
    Icon,
    Layout: Container,
    Row: Clickable,
    Text
  };
});

const TXID = 'ab'.repeat(32);
const RAW_DETAIL = 'HTTP 502: [url] Bad gateway';

function logic(overrides: Partial<ReturnType<typeof useTxFailScreenLogic>> = {}) {
  return {
    outcome: 'unknown' as const,
    reason: 'network' as const,
    txid: TXID,
    detail: RAW_DETAIL,
    canRetry: true,
    canCheckStatus: true,
    busy: null,
    isRetrying: false,
    isChecking: false,
    statusNotice: null,
    retryBlocked: null,
    onClickBack: vi.fn(),
    onClickBackToWallet: vi.fn(),
    onClickRetry: vi.fn(),
    onClickCheckStatus: vi.fn(),
    onClickCopyTxid: vi.fn(),
    t: (key: string, substitutions?: string | string[]) =>
      substitutions ? `${key}:${(Array.isArray(substitutions) ? substitutions : [substitutions]).join(',')}` : key,
    ...overrides
  } as unknown as ReturnType<typeof useTxFailScreenLogic>;
}

describe('TxFailScreen', () => {
  beforeEach(() => {
    vi.mocked(useTxFailScreenLogic).mockReturnValue(logic());
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the unknown outcome with its replacement warning and every recovery action', () => {
    render(<TxFailScreen />);

    expect(screen.getByTestId('tx-fail-title').textContent).toBe('tx_unknown_title');
    expect(screen.getByTestId('tx-fail-body').textContent).toBe('tx_unknown_body');
    expect(screen.getByTestId('tx-fail-reason').textContent).toBe('tx_broadcast_reason_network');
    expect(screen.getByTestId('tx-fail-replacement-warning').textContent).toBe('tx_unknown_warning');
    expect(screen.getByTestId('tx-fail-signature-notice').textContent).toBe('tx_broadcast_signature_notice');
    expect(screen.getByTestId('tx-fail-retry-notice').textContent).toBe('tx_broadcast_retry_notice');
    expect(screen.getByTestId('tx-fail-txid').getAttribute('data-txid')).toBe(TXID);
    expect(screen.getByTestId('tx-fail-retry-button').textContent).toBe('tx_broadcast_retry');
    expect(screen.getByTestId('tx-fail-check-status-button').textContent).toBe('tx_broadcast_check_status');
    expect(screen.getByTestId('tx-fail-back-button').textContent).toBe('tx_broadcast_back_to_wallet');
    expect(document.querySelector('[data-icon="alert"]')).not.toBeNull();
    expect(document.querySelector('[data-icon="delete"]')).toBeNull();
  });

  it('renders the not_sent outcome without the replacement warning or status check', () => {
    vi.mocked(useTxFailScreenLogic).mockReturnValue(
      logic({ outcome: 'not_sent', reason: 'rejected', canCheckStatus: false, detail: '' })
    );
    render(<TxFailScreen />);

    expect(screen.getByTestId('tx-fail-title').textContent).toBe('tx_not_sent_title');
    expect(screen.getByTestId('tx-fail-body').textContent).toBe('tx_not_sent_body');
    expect(screen.getByTestId('tx-fail-reason').textContent).toBe('tx_broadcast_reason_rejected');
    expect(screen.queryByTestId('tx-fail-replacement-warning')).toBeNull();
    expect(screen.queryByTestId('tx-fail-check-status-button')).toBeNull();
    expect(screen.queryByTestId('tx-fail-details-toggle')).toBeNull();
    expect(screen.getByTestId('tx-fail-signature-notice')).not.toBeNull();
    expect(screen.getByTestId('tx-fail-retry-button')).not.toBeNull();
  });

  it('shows neutral reason copy when an unknown verdict came from an unconfirmed rejection', () => {
    vi.mocked(useTxFailScreenLogic).mockReturnValue(logic({ outcome: 'unknown', reason: 'rejected' }));
    render(<TxFailScreen />);

    // The node answered with a rejection, but the lookups that would prove
    // the transaction absent could not: under "status unknown" the definitive
    // rejected line would read as "failed, send it again".
    expect(screen.getByTestId('tx-fail-title').textContent).toBe('tx_unknown_title');
    expect(screen.getByTestId('tx-fail-body').textContent).toBe('tx_unknown_body');
    expect(screen.getByTestId('tx-fail-reason').textContent).toBe('tx_broadcast_reason_rejected_unconfirmed');
    expect(screen.getByTestId('tx-fail-replacement-warning').textContent).toBe('tx_unknown_warning');
    expect(screen.getByTestId('tx-fail-check-status-button')).not.toBeNull();
  });

  it('shows neutral reason copy when an unknown verdict came from a reservation the wallet no longer holds', () => {
    vi.mocked(useTxFailScreenLogic).mockReturnValue(logic({ outcome: 'unknown', reason: 'guard_blocked' }));
    render(<TxFailScreen />);

    // The guard refused because the claim for this exact transaction is
    // gone: an earlier broadcast whose success never reached the UI consumed
    // it. "Conflicts with another approved transaction" would be false here.
    expect(screen.getByTestId('tx-fail-title').textContent).toBe('tx_unknown_title');
    expect(screen.getByTestId('tx-fail-reason').textContent).toBe('tx_broadcast_reason_guard_blocked_unconfirmed');
    expect(screen.getByTestId('tx-fail-replacement-warning').textContent).toBe('tx_unknown_warning');
    expect(screen.getByTestId('tx-fail-check-status-button')).not.toBeNull();
  });

  it('keeps technical detail out of the primary copy until the disclosure is opened', () => {
    render(<TxFailScreen />);

    expect(screen.queryByTestId('tx-fail-details')).toBeNull();
    expect(screen.queryByText(RAW_DETAIL)).toBeNull();
    for (const id of ['tx-fail-title', 'tx-fail-body', 'tx-fail-reason']) {
      expect(screen.getByTestId(id).textContent).not.toContain('HTTP');
    }

    fireEvent.click(screen.getByTestId('tx-fail-details-toggle'));
    expect(screen.getByTestId('tx-fail-details').textContent).toBe(RAW_DETAIL);

    fireEvent.click(screen.getByTestId('tx-fail-details-toggle'));
    expect(screen.queryByTestId('tx-fail-details')).toBeNull();
  });

  it('wires header back and back-to-wallet to the send-flow exits', () => {
    const current = logic();
    vi.mocked(useTxFailScreenLogic).mockReturnValue(current);
    render(<TxFailScreen />);

    fireEvent.click(screen.getByTestId('header-back-button'));
    fireEvent.click(screen.getByTestId('tx-fail-back-button'));
    fireEvent.click(screen.getByTestId('tx-fail-retry-button'));
    fireEvent.click(screen.getByTestId('tx-fail-check-status-button'));

    expect(current.onClickBack).toHaveBeenCalledTimes(1);
    expect(current.onClickBackToWallet).toHaveBeenCalledTimes(1);
    expect(current.onClickRetry).toHaveBeenCalledTimes(1);
    expect(current.onClickCheckStatus).toHaveBeenCalledTimes(1);
  });

  it('disables every action, including header back, while a retry is in flight', () => {
    const current = logic({ busy: 'retry', isRetrying: true });
    vi.mocked(useTxFailScreenLogic).mockReturnValue(current);
    render(<TxFailScreen />);

    const retry = screen.getByTestId('tx-fail-retry-button') as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.getAttribute('data-loading')).toBe('true');
    expect((screen.getByTestId('tx-fail-check-status-button') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('tx-fail-back-button') as HTMLButtonElement).disabled).toBe(true);
    const headerBack = screen.getByTestId('header-back-button') as HTMLButtonElement;
    expect(headerBack.disabled).toBe(true);

    fireEvent.click(headerBack);
    fireEvent.click(screen.getByTestId('tx-fail-back-button'));
    expect(current.onClickBack).not.toHaveBeenCalled();
    expect(current.onClickBackToWallet).not.toHaveBeenCalled();
  });

  it('disables every action, including header back, while a status check is in flight', () => {
    const current = logic({ busy: 'check', isChecking: true });
    vi.mocked(useTxFailScreenLogic).mockReturnValue(current);
    render(<TxFailScreen />);

    const check = screen.getByTestId('tx-fail-check-status-button') as HTMLButtonElement;
    expect(check.disabled).toBe(true);
    expect(check.getAttribute('data-loading')).toBe('true');
    expect((screen.getByTestId('tx-fail-retry-button') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('header-back-button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('header-back-button'));
    expect(current.onClickBack).not.toHaveBeenCalled();
  });

  it('surfaces status-check and blocked-retry notices', () => {
    vi.mocked(useTxFailScreenLogic).mockReturnValue(logic({ statusNotice: 'gone', retryBlocked: 'chain_changed' }));
    render(<TxFailScreen />);

    expect(screen.getByTestId('tx-fail-status-notice').textContent).toBe('tx_broadcast_status_gone');
    expect(screen.getByTestId('tx-fail-retry-blocked').textContent).toBe(
      'tx_broadcast_retry_blocked:tx_broadcast_reason_chain_changed'
    );
  });
});
