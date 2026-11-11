import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { getUiType } from '@/ui/utils';
import { useI18n } from '@qbit/wallet-state';

import { Progress } from '@/ui/components/Progress';

import { LongSigningNotice, SigningProgress } from './index';

vi.mock('@/ui/utils', () => ({ getUiType: vi.fn() }));

// Layout stand-ins; the progress bar is the real one, whose semantics are under test.
vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children, 'data-testid': testId }: { children?: ReactNode; 'data-testid'?: string }) =>
    React.createElement('div', { 'data-testid': testId }, children);
  const Text = ({ text, 'data-testid': testId }: { text?: string; 'data-testid'?: string }) =>
    React.createElement('span', { 'data-testid': testId }, text);
  return {
    Column: Container,
    Icon: Container,
    Row: Container,
    Text,
    Progress: (await import('@/ui/components/Progress')).Progress
  };
});

vi.mock('@qbit/wallet-state', () => ({ useI18n: vi.fn() }));

// Shows each key with what it was given, so a test sees the numbers it carries.
const t = (key: string, substitutions?: string | string[]) =>
  substitutions === undefined ? key : `${key}:${([] as string[]).concat(substitutions).join(',')}`;

function inPopup(isPop: boolean) {
  vi.mocked(getUiType).mockReturnValue({ isPop, isNotification: !isPop, isTab: false, isSidePanel: false } as any);
}

beforeEach(() => {
  vi.mocked(useI18n).mockReturnValue({ t } as any);
  inPopup(true);
});

afterEach(cleanup);

describe('SigningProgress (#171)', () => {
  it('says the signing is starting until the signer counts an input', () => {
    render(<SigningProgress progress={{}} />);

    expect(screen.getByTestId('signing-progress-count').textContent).toBe('signing_progress_starting');
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    expect(bar.getAttribute('aria-valuetext')).toBe('signing_progress_starting');
    expect(screen.queryByTestId('signing-progress-time-left')).toBeNull();
    expect(screen.queryByTestId('signing-progress-transaction')).toBeNull();
  });

  it('shows how many inputs are signed, on the bar and in words', () => {
    render(<SigningProgress progress={{ signed: 36, total: 106 }} />);

    expect(screen.getByTestId('signing-progress-count').textContent).toBe('signing_progress_inputs:36,106');
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('34');
    expect(bar.getAttribute('aria-valuetext')).toBe('signing_progress_inputs:36,106');
    expect(bar.getAttribute('aria-label')).toBe('signing_progress_title');
  });

  it('shows the time left in whole minutes, and under a minute as such', () => {
    const { rerender } = render(<SigningProgress progress={{ signed: 36, total: 106, remainingMs: 90_000 }} />);
    expect(screen.getByTestId('signing-progress-time-left').textContent).toBe('signing_progress_minutes_left:2');

    rerender(<SigningProgress progress={{ signed: 100, total: 106, remainingMs: 59_999 }} />);
    expect(screen.getByTestId('signing-progress-time-left').textContent).toBe('signing_progress_under_a_minute');
  });

  it('keeps the keep-open notice at 100%, since the page still has to hand the result off', () => {
    render(<SigningProgress progress={{ signed: 106, total: 106 }} />);

    expect(screen.getByTestId('signing-progress-title').textContent).toBe('signing_progress_title');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    expect(screen.getByTestId('signing-keep-open-notice')).toBeTruthy();
  });

  it('reads as signed, without the notice, once the result is handed off', () => {
    render(<SigningProgress progress={{ signed: 106, total: 106 }} handedOff />);

    expect(screen.getByTestId('signing-progress-title').textContent).toBe('signed');
    expect(screen.queryByTestId('signing-keep-open-notice')).toBeNull();
  });

  it('names the transaction of a batch of several', () => {
    const { rerender } = render(
      <SigningProgress progress={{ signed: 1, total: 4, transactionIndex: 1, transactionCount: 3 }} />
    );
    expect(screen.getByTestId('signing-progress-transaction').textContent).toBe('signing_progress_transaction:2,3');

    rerender(<SigningProgress progress={{ signed: 1, total: 4, transactionIndex: 0, transactionCount: 1 }} />);
    expect(screen.queryByTestId('signing-progress-transaction')).toBeNull();
  });

  it('warns a popup that clicking outside it closes it, and a window only about closing', () => {
    render(<SigningProgress progress={null} />);
    expect(screen.getByTestId('signing-keep-open-notice').textContent).toContain('signing_keep_open_popup');

    cleanup();
    inPopup(false);
    render(<SigningProgress progress={null} />);
    const notice = screen.getByTestId('signing-keep-open-notice').textContent;
    expect(notice).toContain('signing_keep_open');
    expect(notice).not.toContain('signing_keep_open_popup');
  });
});

describe('LongSigningNotice (#171)', () => {
  it('names the input count, and points a popup to the sidebar', () => {
    render(<LongSigningNotice inputCount={106} />);
    const notice = screen.getByTestId('long-signing-notice').textContent;
    expect(notice).toContain('signing_many_inputs_title');
    expect(notice).toContain('signing_many_inputs_body:106');
    expect(notice).toContain('signing_many_inputs_sidebar');
  });

  it('leaves the sidebar out where the wallet is already open in its own window', () => {
    inPopup(false);
    render(<LongSigningNotice inputCount={106} />);
    expect(screen.getByTestId('long-signing-notice').textContent).not.toContain('signing_many_inputs_sidebar');
  });
});

describe('Progress (#171)', () => {
  it('is a named progressbar only when given a name', () => {
    const { rerender } = render(<Progress percent={50} />);
    expect(screen.queryByRole('progressbar')).toBeNull();

    rerender(<Progress percent={50} ariaLabel="Uploading" ariaValueText="Half" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-label')).toBe('Uploading');
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(bar.getAttribute('aria-valuetext')).toBe('Half');
  });
});
