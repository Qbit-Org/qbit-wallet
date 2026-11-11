import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useFeeRateBarLogic, useI18n } from '@qbit/wallet-state';

import { FeeRateBar } from '.';

vi.mock('@qbit/wallet-state', () => ({
  useFeeRateBarLogic: vi.fn(),
  useI18n: vi.fn()
}));

// The props the fee bar last gave its Custom rate input.
const inputProps = vi.hoisted(() => ({ current: undefined as Record<string, unknown> | undefined }));

vi.mock('../Input', () => ({
  Input: (props: Record<string, unknown>) => {
    inputProps.current = props;
    return null;
  }
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
      { index: 0, title: 'slow', desc: 'slow description', feeRate: 1 },
      { index: 1, title: 'avg', desc: 'average description', feeRate: 2 }
    ],
    feeOptionIndex: 1,
    setFeeOptionIndex,
    feeRateInputVal: '',
    adjustFeeRateInput: vi.fn(),
    minFeeRate: 0.25,
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
    inputProps.current = undefined;
    vi.mocked(useI18n).mockReturnValue({
      t: (key: string, substitutions?: string | string[] | Record<string, string | number>) =>
        Array.isArray(substitutions) ? `${key}:${substitutions.join(',')}` : key
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

  it('names the 1 bit/vB fallback rate in use instead of presenting it as a live estimate', () => {
    vi.mocked(useFeeRateBarLogic).mockReturnValue({
      ...defaultFeeRateLogic,
      feeOptions: [
        { index: 0, title: 'slow', desc: '~20 min', feeRate: 1 },
        { index: 1, title: 'avg', desc: '~6 min', feeRate: 1 },
        { index: 2, title: 'fast', desc: '~2 min', feeRate: 1 }
      ],
      feeEstimateUnavailable: true,
      fallbackFeeRate: 1
    } as ReturnType<typeof useFeeRateBarLogic>);

    render(<FeeRateBar />);

    expect(screen.getByTestId('fee-estimates-unavailable').textContent).toBe(
      'fee_estimates_unavailable_using_default:1'
    );
  });

  it('offers the rates of the quote its screen shares instead of reading its own', () => {
    const quote = {
      status: 'loaded' as const,
      summary: { list: [{ title: 'slow', desc: '', feeRate: 1 }] }
    };

    render(<FeeRateBar quote={quote} />);

    expect(useFeeRateBarLogic).toHaveBeenCalledWith(expect.objectContaining({ quote }));
  });

  it('selects Custom from a bar that offers only Custom', () => {
    const customOption = { type: 3, index: 3, title: 'custom', feeRate: 0 };
    const logic = {
      ...defaultFeeRateLogic,
      feeOptions: [customOption],
      isCustomOption: (option: { type?: number }) => option.type === 3,
      feeEstimateUnavailable: true
    } as ReturnType<typeof useFeeRateBarLogic>;
    vi.mocked(useFeeRateBarLogic).mockReturnValue(logic);

    const { rerender } = render(<FeeRateBar />);
    const custom = screen.getByTestId('fee-rate-option-3');
    expect(custom.getAttribute('data-selected')).toBe('false');
    fireEvent.click(custom);
    expect(setFeeOptionIndex).toHaveBeenCalledWith(3);
    expect(toggleCustomInput).not.toHaveBeenCalled();

    vi.mocked(useFeeRateBarLogic).mockReturnValue({ ...logic, feeOptionIndex: 3 });
    rerender(<FeeRateBar />);
    expect(screen.getByTestId('fee-rate-option-3').getAttribute('data-selected')).toBe('true');
  });

  it('selects the option each tile stands for, not its position', () => {
    vi.mocked(useFeeRateBarLogic).mockReturnValue({
      ...defaultFeeRateLogic,
      feeOptions: [
        { index: 0, title: 'slow', desc: '', feeRate: 1 },
        { index: 2, title: 'fast', desc: '', feeRate: 3 }
      ],
      feeOptionIndex: 2
    } as ReturnType<typeof useFeeRateBarLogic>);

    render(<FeeRateBar />);
    const fast = screen.getByTestId('fee-rate-option-2');
    expect(fast.getAttribute('data-selected')).toBe('true');
    expect(screen.queryByTestId('fee-rate-option-1')).toBeNull();
    fireEvent.click(screen.getByTestId('fee-rate-option-0'));
    expect(setFeeOptionIndex).toHaveBeenCalledWith(0);
  });

  it.each([false, true])(
    'gives the Custom rate input the relay floor as its minimum, with low-fee mode %s',
    (supportLowFeeMode) => {
      vi.mocked(useFeeRateBarLogic).mockReturnValue({
        ...defaultFeeRateLogic,
        showCustomInput: true,
        feeRateInputVal: '0.25',
        supportLowFeeMode
      } as ReturnType<typeof useFeeRateBarLogic>);

      render(<FeeRateBar />);

      expect(inputProps.current).toMatchObject({
        value: '0.25',
        min: 0.25,
        step: 0.01,
        decimalPlaces: 2,
        enableStepper: true
      });
    }
  );

  it('shows tiers below 1 bit/vB at their own rates', () => {
    vi.mocked(useFeeRateBarLogic).mockReturnValue({
      ...defaultFeeRateLogic,
      feeOptions: [
        { index: 0, title: 'slow', desc: '', feeRate: 0.25 },
        { index: 1, title: 'avg', desc: '', feeRate: 0.5 },
        { index: 2, title: 'fast', desc: '', feeRate: 1 }
      ]
    } as ReturnType<typeof useFeeRateBarLogic>);

    render(<FeeRateBar />);

    expect(screen.getByTestId('fee-rate-option-0').textContent).toContain('0.25 bits/vB');
    expect(screen.getByTestId('fee-rate-option-1').textContent).toContain('0.5 bits/vB');
    expect(screen.getByTestId('fee-rate-option-2').textContent).toContain('1 bits/vB');
  });

  it('says estimates are unavailable without claiming a rate when it picks none', () => {
    vi.mocked(useFeeRateBarLogic).mockReturnValue({
      ...defaultFeeRateLogic,
      feeOptions: [],
      feeEstimateUnavailable: true,
      fallbackFeeRate: undefined
    } as ReturnType<typeof useFeeRateBarLogic>);

    render(<FeeRateBar readonly />);

    expect(screen.getByTestId('fee-estimates-unavailable').textContent).toBe('fee_estimates_unavailable');
  });
});
