import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useI18n } from '@qbit/wallet-state';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import WebsiteCheckWarning from './WebsiteCheckWarning';

// The components barrel pulls in the whole route tree; the warning only needs
// these primitives, so render the real ones without the rest of the barrel.
vi.mock('@/ui/components', async () => {
  const [{ Icon }, { Row }, { Text }] = await Promise.all([
    import('@/ui/components/Icon'),
    import('@/ui/components/Row'),
    import('@/ui/components/Text')
  ]);
  return { Icon, Row, Text };
});

vi.mock('@/ui/theme/colors', () => ({
  colors: {
    text: '#101412',
    textDim: '#4f6056',
    warning: '#b54708',
    warning_bg: '#fff4cc',
    warning_content: '#f4b62c'
  }
}));

vi.mock('@qbit/wallet-state', () => ({
  useI18n: vi.fn()
}));

const copy = {
  warning: 'Warning',
  try_again: 'Try again',
  website_check_failed: "Qbit Wallet couldn't verify this website. Check your connection and try again."
} as const;

const TIMEOUT_WARNING =
  'The local website-safety check timed out. Retry, reject, or continue only if you independently trust this site.';

describe('WebsiteCheckWarning', () => {
  beforeEach(() => {
    vi.mocked(useI18n).mockReturnValue({
      t: (key: string) => copy[key as keyof typeof copy] ?? key
    } as any);
  });

  afterEach(cleanup);

  it('renders the complete fallback copy in the amber treatment as an alert', () => {
    render(<WebsiteCheckWarning onRetry={vi.fn()} />);

    const warning = screen.getByTestId('website-check-warning');
    expect(warning.getAttribute('role')).toBe('alert');
    expect(warning.style.backgroundColor).toBe('rgb(255, 244, 204)');
    expect(warning.style.border).toContain('rgb(244, 182, 44)');
    expect(screen.getByText(copy.warning)).not.toBeNull();
    expect(screen.getByTestId('website-check-error').textContent).toBe(copy.website_check_failed);
  });

  it('prefers the verdict-specific warning copy when one is provided', () => {
    render(<WebsiteCheckWarning warning={TIMEOUT_WARNING} onRetry={vi.fn()} />);

    expect(screen.getByTestId('website-check-error').textContent).toBe(TIMEOUT_WARNING);
  });

  it('exposes Retry as a focusable native text button that calls back on activation', () => {
    const onRetry = vi.fn();
    render(<WebsiteCheckWarning onRetry={onRetry} />);

    const retry = screen.getByRole('button', { name: copy.try_again });
    expect(retry).toBe(screen.getByTestId('website-check-retry-button'));
    expect(retry.tagName).toBe('BUTTON');
    expect(retry.getAttribute('type')).toBe('button');
    // Link-style presentation instead of the shared full-width Button.
    expect(retry.className).toBe('approval-website-check-retry');

    retry.focus();
    expect(document.activeElement).toBe(retry);

    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('reaches Retry with Tab and activates it with Enter and Space', () => {
    const onRetry = vi.fn();
    render(<WebsiteCheckWarning onRetry={onRetry} />);

    userEvent.tab();
    const retry = screen.getByRole('button', { name: copy.try_again });
    expect(document.activeElement).toBe(retry);

    userEvent.keyboard('{enter}');
    expect(onRetry).toHaveBeenCalledTimes(1);
    userEvent.keyboard(' ');
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('offers no control other than Retry, so it cannot be collapsed or dismissed', () => {
    render(<WebsiteCheckWarning onRetry={vi.fn()} />);

    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it.each([['psbt-'], ['message-']] as const)('keeps the %s surface test ids', (prefix) => {
    render(<WebsiteCheckWarning onRetry={vi.fn()} testIdPrefix={prefix} />);

    expect(screen.getByTestId(`${prefix}website-check-warning`).getAttribute('role')).toBe('alert');
    expect(screen.getByTestId(`${prefix}website-check-error`).textContent).toBe(copy.website_check_failed);
    expect(screen.getByTestId(`${prefix}website-check-retry-button`).textContent).toBe(copy.try_again);
  });
});
