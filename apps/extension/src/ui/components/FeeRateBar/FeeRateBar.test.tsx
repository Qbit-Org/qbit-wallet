import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useFeeRateBarLogic, useI18n } from '@qbit/wallet-state';

import { FeeRateBar } from '.';

vi.mock('@qbit/wallet-state', () => ({
  useFeeRateBarLogic: vi.fn(),
  useI18n: vi.fn()
}));

vi.mock('../Input', () => ({
  Input: () => null
}));

vi.mock('../Text', () => ({
  Text: ({ text, 'data-testid': dataTestId }: { text?: string | number; 'data-testid'?: string }) => (
    <span data-testid={dataTestId}>{text}</span>
  )
}));

describe('FeeRateBar', () => {
  const setFeeOptionIndex = vi.fn();
  const toggleCustomInput = vi.fn();
  const defaultFeeRateLogic = {
    feeOptions: [
      { title: 'slow', desc: 'slow description', feeRate: 1 },
      { title: 'avg', desc: 'average description', feeRate: 2 }
    ],
    feeOptionIndex: 1,
    setFeeOptionIndex,
    feeRateInputVal: '',
    adjustFeeRateInput: vi.fn(),
    isCustomOption: vi.fn(() => false),
    fontSize: 'xxs',
    isSpecialLocale: false,
    showCustomInput: false,
    toggleCustomInput,
    supportLowFeeMode: false,
    feeEstimateUnavailable: false,
    fallbackFeeRate: 1,
    feeQuote: undefined
  } as ReturnType<typeof useFeeRateBarLogic>;

  beforeEach(() => {
    vi.mocked(useI18n).mockReturnValue({
      t: (key: string) => key
    } as ReturnType<typeof useI18n>);
    vi.mocked(useFeeRateBarLogic).mockReturnValue(defaultFeeRateLogic);
  });

  afterEach(() => {
    cleanup();
  });

  it('exposes the selected option and preserves fee option click behavior', () => {
    render(<FeeRateBar />);

    const unselectedOption = screen.getByTestId('fee-rate-option-0');
    const selectedOption = screen.getByTestId('fee-rate-option-1');
    expect(unselectedOption.getAttribute('data-selected')).toBe('false');
    expect(selectedOption.getAttribute('data-selected')).toBe('true');

    fireEvent.click(selectedOption);
    expect(setFeeOptionIndex).toHaveBeenCalledWith(1);
    expect(toggleCustomInput).toHaveBeenCalledWith(true);

    setFeeOptionIndex.mockClear();
    toggleCustomInput.mockClear();
    fireEvent.click(unselectedOption);
    expect(setFeeOptionIndex).toHaveBeenCalledWith(0);
    expect(toggleCustomInput).not.toHaveBeenCalled();
  });

  it('labels relay-floor fallback instead of presenting it as a live estimate', () => {
    vi.mocked(useFeeRateBarLogic).mockReturnValue({
      ...defaultFeeRateLogic,
      feeOptions: [
        { title: 'slow', desc: '~20 min', feeRate: 1 },
        { title: 'avg', desc: '~6 min', feeRate: 1 },
        { title: 'fast', desc: '~2 min', feeRate: 1 }
      ],
      feeEstimateUnavailable: true,
      fallbackFeeRate: 1
    } as ReturnType<typeof useFeeRateBarLogic>);

    render(<FeeRateBar />);

    expect(screen.getByTestId('fee-estimates-unavailable').textContent).toBe('fee_estimates_unavailable_using_floor');
  });
});
