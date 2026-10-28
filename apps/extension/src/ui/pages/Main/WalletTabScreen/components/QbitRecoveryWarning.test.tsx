import type { CSSProperties, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useI18n } from '@qbit/wallet-state';

import { QbitRecoveryWarning } from './QbitRecoveryWarning';

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
  const Checkbox = ({
    children,
    checked,
    onChange,
    'data-testid': dataTestId
  }: {
    children?: ReactNode;
    checked?: boolean;
    onChange?: (event: { target: { checked: boolean } }) => void;
    'data-testid'?: string;
  }) =>
    React.createElement(
      'label',
      null,
      React.createElement('input', {
        type: 'checkbox',
        checked,
        onChange,
        'data-testid': dataTestId
      }),
      children
    );
  const Text = ({ text, 'data-testid': dataTestId }: { text?: string; 'data-testid'?: string }) =>
    React.createElement('span', { 'data-testid': dataTestId }, text);
  const Icon = ({ icon, 'data-testid': dataTestId }: { icon?: string; 'data-testid'?: string }) =>
    React.createElement('span', { 'data-testid': dataTestId, 'data-icon': icon });
  const ClickableContainer = ({
    children,
    style,
    onClick,
    'data-testid': dataTestId
  }: {
    children?: ReactNode;
    style?: CSSProperties;
    onClick?: () => void;
    'data-testid'?: string;
  }) => React.createElement('div', { style, onClick, 'data-testid': dataTestId }, children);

  return {
    Button,
    Card: Container,
    Checkbox,
    Column: Container,
    Icon,
    Row: ClickableContainer,
    Text
  };
});

vi.mock('@qbit/wallet-state', () => ({
  useI18n: vi.fn()
}));

const seedOnlyState = {
  status: 'seed-only-restored',
  acknowledgement: 'required',
  counterConfidence: 'chain-floor-only',
  knownOnChainSignatures: 13
} as any;

describe('QbitRecoveryWarning', () => {
  afterEach(cleanup);

  it('keeps the precise restored-floor warning visible and requires explicit continued-use acceptance', () => {
    vi.mocked(useI18n).mockReturnValue({
      t: (key: string, substitutions?: string | string[]) =>
        substitutions === undefined
          ? key
          : `${key}:${Array.isArray(substitutions) ? substitutions.join(',') : substitutions}`
    } as any);
    const onAcceptedChange = vi.fn();
    const onAcknowledge = vi.fn();
    const onMoveFunds = vi.fn();
    const { rerender } = render(
      <QbitRecoveryWarning
        state={seedOnlyState}
        accepted={false}
        onAcceptedChange={onAcceptedChange}
        onAcknowledge={onAcknowledge}
        onMoveFunds={onMoveFunds}
        onDismiss={vi.fn()}
      />
    );

    expect(screen.getByTestId('qbit-recovery-warning')).toBeTruthy();
    expect(screen.getByText('qbit_recovery_warning_body')).toBeTruthy();
    expect(screen.getByText('qbit_recovery_warning_recommendation')).toBeTruthy();
    expect(screen.getByText('qbit_recovery_or_divider')).toBeTruthy();
    expect((screen.getByTestId('qbit-recovery-acknowledge-button') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('qbit-recovery-continued-use-checkbox'));
    expect(onAcceptedChange).toHaveBeenCalledWith(true);
    rerender(
      <QbitRecoveryWarning
        state={seedOnlyState}
        accepted
        onAcceptedChange={onAcceptedChange}
        onAcknowledge={onAcknowledge}
        onMoveFunds={onMoveFunds}
        onDismiss={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId('qbit-recovery-acknowledge-button'));
    fireEvent.click(screen.getByTestId('qbit-recovery-move-funds-button'));
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
    expect(onMoveFunds).toHaveBeenCalledTimes(1);
  });

  it('hides the move-funds action when a seed-only state retains an existing migration', () => {
    vi.mocked(useI18n).mockReturnValue({
      t: (key: string, substitutions?: string | string[]) =>
        substitutions === undefined
          ? key
          : `${key}:${Array.isArray(substitutions) ? substitutions.join(',') : substitutions}`
    } as any);

    render(
      <QbitRecoveryWarning
        state={{
          ...seedOnlyState,
          acknowledgement: 'accepted',
          migration: {
            destinationKeyringIndex: 3,
            destinationAddress: 'qbrt1zdestination',
            network: 'regtest',
            plans: []
          }
        }}
        accepted={false}
        onAcceptedChange={vi.fn()}
        onAcknowledge={vi.fn()}
        onMoveFunds={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    expect(screen.getByTestId('qbit-recovery-warning')).toBeTruthy();
    fireEvent.click(screen.getByTestId('qbit-recovery-warning-toggle'));
    expect(screen.queryByTestId('qbit-recovery-move-funds-button')).toBeNull();
    expect(screen.getByTestId('qbit-recovery-dismiss-button')).toBeTruthy();
  });

  it('collapses to an expandable banner after acknowledgement and supports permanent dismissal', () => {
    vi.mocked(useI18n).mockReturnValue({
      t: (key: string, substitutions?: string | string[]) =>
        substitutions === undefined
          ? key
          : `${key}:${Array.isArray(substitutions) ? substitutions.join(',') : substitutions}`
    } as any);
    const onDismiss = vi.fn();
    const { rerender } = render(
      <QbitRecoveryWarning
        state={{ ...seedOnlyState, acknowledgement: 'accepted' }}
        accepted={false}
        onAcceptedChange={vi.fn()}
        onAcknowledge={vi.fn()}
        onMoveFunds={vi.fn()}
        onDismiss={onDismiss}
      />
    );

    // Collapsed by default: the residual banner keeps only the short title.
    expect(screen.getByTestId('qbit-recovery-warning')).toBeTruthy();
    expect(screen.getByText('qbit_recovery_warning_collapsed_title')).toBeTruthy();
    expect(screen.queryByTestId('qbit-recovery-continued-use-checkbox')).toBeNull();
    expect(screen.queryByText('qbit_recovery_warning_body')).toBeNull();
    expect(screen.queryByTestId('qbit-recovery-move-funds-button')).toBeNull();

    fireEvent.click(screen.getByTestId('qbit-recovery-warning-toggle'));
    expect(screen.getByText('qbit_recovery_warning_body')).toBeTruthy();
    expect(screen.getByText('qbit_recovery_warning_recommendation')).toBeTruthy();
    expect(screen.getByTestId('qbit-recovery-move-funds-button')).toBeTruthy();

    fireEvent.click(screen.getByTestId('qbit-recovery-dismiss-button'));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('qbit-recovery-warning-toggle'));
    expect(screen.queryByText('qbit_recovery_warning_body')).toBeNull();

    rerender(
      <QbitRecoveryWarning
        state={{ ...seedOnlyState, acknowledgement: 'accepted', warningDismissed: true }}
        accepted={false}
        onAcceptedChange={vi.fn()}
        onAcknowledge={vi.fn()}
        onMoveFunds={vi.fn()}
        onDismiss={onDismiss}
      />
    );
    expect(screen.queryByTestId('qbit-recovery-warning')).toBeNull();
  });

  it('retains a compact warning after acknowledgement and exposes resumable archived states', () => {
    vi.mocked(useI18n).mockReturnValue({
      t: (key: string, substitutions?: string | string[]) =>
        substitutions === undefined
          ? key
          : `${key}:${Array.isArray(substitutions) ? substitutions.join(',') : substitutions}`
    } as any);
    const onMoveFunds = vi.fn();
    const props = {
      accepted: false,
      onAcceptedChange: vi.fn(),
      onAcknowledge: vi.fn(),
      onMoveFunds,
      onDismiss: vi.fn()
    };
    const { rerender } = render(
      <QbitRecoveryWarning {...props} state={{ ...seedOnlyState, acknowledgement: 'accepted' }} />
    );

    expect(screen.getByTestId('qbit-recovery-warning')).toBeTruthy();
    expect(screen.queryByTestId('qbit-recovery-continued-use-checkbox')).toBeNull();
    fireEvent.click(screen.getByTestId('qbit-recovery-warning-toggle'));
    expect(screen.getByTestId('qbit-recovery-move-funds-button')).toBeTruthy();

    rerender(
      <QbitRecoveryWarning
        {...props}
        state={{
          ...seedOnlyState,
          status: 'migrating',
          acknowledgement: 'accepted',
          migration: {
            destinationAddress: 'qbrt1zdestination',
            plans: [
              { id: 'one', status: 'confirmed' },
              { id: 'two', status: 'broadcast' }
            ]
          }
        }}
      />
    );
    expect(screen.getByTestId('qbit-recovery-migrating')).toBeTruthy();
    expect(screen.getByText('qbit_recovery_progress:1,2')).toBeTruthy();

    rerender(
      <QbitRecoveryWarning
        {...props}
        state={{
          ...seedOnlyState,
          status: 'migrated',
          acknowledgement: 'accepted',
          migration: { destinationAddress: 'qbrt1zdestination', plans: [] }
        }}
      />
    );
    expect(screen.getByTestId('qbit-recovery-archived')).toBeTruthy();
    expect(screen.queryByTestId('qbit-recovery-other-networks-hint')).toBeNull();
    fireEvent.click(screen.getByTestId('qbit-recovery-resume-button'));
    expect(onMoveFunds).toHaveBeenCalledTimes(1);
  });

  it('hints that other networks still await recovery on the archived card', () => {
    vi.mocked(useI18n).mockReturnValue({
      t: (key: string, substitutions?: string | string[]) =>
        substitutions === undefined
          ? key
          : `${key}:${Array.isArray(substitutions) ? substitutions.join(',') : substitutions}`
    } as any);

    render(
      <QbitRecoveryWarning
        state={{
          ...seedOnlyState,
          status: 'migrated',
          acknowledgement: 'accepted',
          migration: { destinationAddress: 'qbrt1zdestination', plans: [] },
          otherNetworksPendingRecovery: true
        }}
        accepted={false}
        onAcceptedChange={vi.fn()}
        onAcknowledge={vi.fn()}
        onMoveFunds={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    expect(screen.getByTestId('qbit-recovery-other-networks-hint')).toBeTruthy();
    expect(screen.getByText('qbit_recovery_other_networks_hint')).toBeTruthy();
  });
});
