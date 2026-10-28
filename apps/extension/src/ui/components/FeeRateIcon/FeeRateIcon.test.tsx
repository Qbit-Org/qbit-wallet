import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FeeSummary } from '@qbit/wallet-shared';
import { useChainType, useI18n, useWallet } from '@qbit/wallet-state';
import { ChainType } from '@qbit/wallet-types';

import { FeeRateIcon } from '.';

vi.mock('@qbit/wallet-state', () => ({
  useChainType: vi.fn(),
  useI18n: vi.fn(),
  useWallet: vi.fn()
}));

vi.mock('../Text', () => ({
  Text: ({ text, color }: { text?: string | number; color?: string }) => (
    <span data-testid="fee-rate-text" data-color={color}>
      {text}
    </span>
  )
}));

function feeSummary(normalFeeRate: number, quote?: FeeSummary['quote']): FeeSummary {
  return {
    list: [
      { title: 'Slow', desc: 'slow', feeRate: normalFeeRate },
      { title: 'Normal', desc: 'normal', feeRate: normalFeeRate },
      { title: 'Fast', desc: 'fast', feeRate: normalFeeRate }
    ],
    ...(quote ? { quote } : {})
  };
}

describe('FeeRateIcon', () => {
  const getFeeSummary = vi.fn();

  beforeEach(() => {
    vi.mocked(useChainType).mockReturnValue(ChainType.QBIT_MAINNET);
    vi.mocked(useI18n).mockReturnValue({
      t: (key: string) => key
    } as ReturnType<typeof useI18n>);
    vi.mocked(useWallet).mockReturnValue({ getFeeSummary } as unknown as ReturnType<typeof useWallet>);
  });

  afterEach(() => {
    cleanup();
  });

  async function renderSummary(summary: FeeSummary) {
    let resolveSummary: ((value: FeeSummary) => void) | undefined;
    getFeeSummary.mockReturnValue(
      new Promise<FeeSummary>((resolve) => {
        resolveSummary = resolve;
      })
    );

    render(<FeeRateIcon />);

    const resolve = resolveSummary;
    if (!resolve) {
      throw new Error('Fee summary request was not started');
    }
    await act(async () => {
      resolve(summary);
    });

    return screen.getByTestId('fee-rate-text');
  }

  it('suppresses the relay-floor fallback headline and popover when qbit estimates are unavailable', async () => {
    const headline = await renderSummary(
      feeSummary(1, {
        source: 'esplora',
        availability: 'unavailable',
        freshness: 'fallback',
        fallbackReason: 'unavailable'
      })
    );

    expect(headline.textContent).toBe('-');
    expect(headline.getAttribute('data-color')).toBe('textDim');

    fireEvent.click(headline);

    expect(screen.queryByText('low_priority')).toBeNull();
    expect(screen.queryByText('medium_priority')).toBeNull();
    expect(screen.queryByText('high_priority')).toBeNull();
    expect(screen.queryByText('network_fees')).toBeNull();
  });

  it.each([
    [
      'available qbit quote',
      feeSummary(15, {
        source: 'esplora',
        availability: 'available',
        freshness: 'live'
      })
    ],
    ['quote-less summary', feeSummary(15)]
  ])('keeps the existing numeric headline for an %s', async (_caseName, summary) => {
    const headline = await renderSummary(summary);

    expect(headline.textContent).toBe('15');
    expect(headline.getAttribute('data-color')).toBe('green');

    fireEvent.click(headline);

    expect(screen.getByText('low_priority')).not.toBeNull();
    expect(screen.getByText('network_fees')).not.toBeNull();
    // Each priority box carries its speed icon beside the label.
    expect(screen.getByTestId('fee-priority-fee-low')).not.toBeNull();
    expect(screen.getByTestId('fee-priority-fee-medium')).not.toBeNull();
    expect(screen.getByTestId('fee-priority-fee-high')).not.toBeNull();
  });
});
