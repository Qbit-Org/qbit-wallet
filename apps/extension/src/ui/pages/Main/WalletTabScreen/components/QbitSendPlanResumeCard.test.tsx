import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useQbitSendPlanEntryLogic } from '@qbit/wallet-state';

import { QbitSendPlanResumeCard } from './QbitSendPlanResumeCard';

vi.mock('@qbit/wallet-state', () => ({ useQbitSendPlanEntryLogic: vi.fn() }));

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
    Button: ({ text, onClick, 'data-testid': testId }: MockProps) =>
      React.createElement('button', { onClick, 'data-testid': testId }, text),
    Card: View,
    Column: View,
    Row: View,
    Text: ({ text, color, 'data-testid': testId }: MockProps) =>
      React.createElement('span', { 'data-testid': testId, 'data-color': color }, text)
  };
});

describe('QbitSendPlanResumeCard (#188)', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows nothing without a plan', () => {
    vi.mocked(useQbitSendPlanEntryLogic).mockReturnValue(undefined);
    const { container } = render(<QbitSendPlanResumeCard />);
    expect(container.innerHTML).toBe('');
  });

  it.each([
    ['progress', 'send_plan_home_sending:0.01,QBT', 'send_plan_status_signing:20,156', 'text'],
    ['paused', 'send_plan_home_paused:0.01,QBT', 'send_plan_paused_locked', 'warning'],
    ['sent', 'send_plan_home_sent:0.01,QBT', 'send_plan_status_sent', 'text']
  ] as const)(
    'is one compact card for a plan %s: a title, one status line, one button',
    (tone, title, status, color) => {
      const onClickOpen = vi.fn();
      vi.mocked(useQbitSendPlanEntryLogic).mockReturnValue({ title, status, tone, buttonText: 'view', onClickOpen });
      render(<QbitSendPlanResumeCard />);

      expect(screen.getByTestId('qbit-send-plan-resume')).toBeTruthy();
      expect(screen.getByTestId('qbit-send-plan-resume-title').textContent).toBe(title);
      expect(screen.getByTestId('qbit-send-plan-resume-title').getAttribute('data-color')).toBe(color);
      expect(screen.getByTestId('qbit-send-plan-resume-status').textContent).toBe(status);
      expect(screen.getAllByRole('button')).toHaveLength(1);
      fireEvent.click(screen.getByTestId('qbit-send-plan-resume-button'));
      expect(onClickOpen).toHaveBeenCalledTimes(1);
    }
  );
});
