import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { colors } from '@/ui/theme/colors';

import { NETWORK_OPTION_ROW_HEIGHT, NetworkOptionLabel } from './NetworkOptionLabel';

// The component library's index pulls in wallet-state hooks that cannot
// resolve under the extension's vitest config and a browser shim that reads
// the chrome global on import; the label only needs the Column and Text
// primitives, which touch neither.
vi.mock('@qbit/wallet-state', () => ({}));
vi.hoisted(() => {
  (globalThis as { chrome?: unknown }).chrome = { runtime: {} };
});

describe('NetworkOptionLabel', () => {
  // Also clean before: without worker isolation a previous file's render can leak into this DOM.
  beforeEach(cleanup);
  afterEach(cleanup);

  it('renders a plain label when there is no subtext', () => {
    render(<NetworkOptionLabel label="Qbit Mainnet" />);
    expect(screen.getByText('Qbit Mainnet')).toBeTruthy();
    expect(screen.queryByTestId('network-option-label')).toBeNull();
    expect(screen.queryByTestId('network-option-subtext')).toBeNull();
  });

  it('folds the subtext into the icon height so a two-line row stays as tall as a one-line one', () => {
    render(<NetworkOptionLabel label="Local Regtest" subtext="http://127.0.0.1:3002" preset="regular-bold" />);

    const column = screen.getByTestId('network-option-label');
    expect(column.style.height).toBe(`${NETWORK_OPTION_ROW_HEIGHT}px`);
    expect(Number.parseFloat(column.style.gap)).toBe(0);

    const label = screen.getByText('Local Regtest').parentElement as HTMLElement;
    const subtext = screen.getByTestId('network-option-subtext');
    expect(subtext.textContent).toBe('http://127.0.0.1:3002');
    const lineHeightPx = (element: HTMLElement) => Number.parseFloat(element.style.lineHeight);
    expect(lineHeightPx(label) + lineHeightPx(subtext)).toBe(NETWORK_OPTION_ROW_HEIGHT);
    // The endpoint is secondary detail: fainter than the dim tone used for labels.
    expect(subtext.style.color).toBe(colors.textFaint);
  });
});
