import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useQbitConsolidationScreenLogic } from '@qbit/wallet-state';

import QbitConsolidationScreen from './QbitConsolidationScreen';

vi.mock('@qbit/wallet-state', () => ({
  useQbitConsolidationScreenLogic: vi.fn()
}));

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const View = ({ children, ...props }: any) => React.createElement('div', props, children);
  return {
    Button: ({ text, onClick, disabled, ...props }: any) =>
      React.createElement('button', { ...props, onClick, disabled }, text),
    Column: View,
    Content: View,
    Header: View,
    Layout: View,
    // `wrap` is the real Text's own prop (overflow-wrap: anywhere), shown here as an attribute.
    Text: ({ text, wrap, ...props }: any) =>
      React.createElement('span', { ...props, 'data-wrap': wrap ? 'true' : undefined }, text)
  };
});

// The send amount field's box and input styles, without the rest of the inputs.
vi.mock('@/ui/components/Input', () => ({
  $baseContainerStyle: { display: 'flex' },
  $baseInputStyle: { flex: 1 }
}));

const feeRateBarProps = vi.hoisted(() => ({ quote: undefined as unknown }));
vi.mock('@/ui/components/FeeRateBar', () => ({
  FeeRateBar: ({ quote }: { quote?: unknown }) => {
    feeRateBarProps.quote = quote;
    return <div>fee-rate-bar</div>;
  }
}));

const feeQuote = { status: 'loaded' as const, read: 'read-1', summary: { list: [] } };

function logic(overrides: Partial<ReturnType<typeof useQbitConsolidationScreenLogic>> = {}) {
  return {
    headerTitle: 'consolidate_outputs',
    description: 'consolidation_description',
    status: undefined,
    statusText: 'consolidation_status:812|500|2|106',
    pendingText: '',
    overLimit: true,
    batch: undefined,
    batchSummary: '',
    showBatchSize: true,
    batchSizeLabel: 'consolidation_batch_size_label',
    batchSizeText: '106',
    batchSize: 106,
    maxBatchSize: 106,
    batchSizeRange: 'consolidation_batch_size_range:2|106',
    batchSizeError: '',
    feePreview: 'consolidation_fee_preview:106|797654|398.8',
    costNote: '',
    error: '',
    preparing: false,
    canPrepare: true,
    feeQuote,
    onBatchSizeChange: vi.fn(),
    onClickBatchSizeMax: vi.fn(),
    onClickPrepare: vi.fn(),
    onClickConfirm: vi.fn(),
    t: (key: string) => key,
    ...overrides
  } as ReturnType<typeof useQbitConsolidationScreenLogic>;
}

describe('QbitConsolidationScreen (#277)', () => {
  afterEach(() => {
    cleanup();
  });

  it('prepares one batch at a time', () => {
    const state = logic();
    vi.mocked(useQbitConsolidationScreenLogic).mockReturnValue(state);
    render(<QbitConsolidationScreen />);

    expect(screen.getByTestId('consolidation-status').textContent).toBe('consolidation_status:812|500|2|106');
    // The fee bar offers its rates from the quote the screen holds preparation on.
    expect(feeRateBarProps.quote).toBe(feeQuote);
    expect(screen.queryByTestId('consolidation-confirm-button')).toBeNull();
    fireEvent.click(screen.getByTestId('consolidation-prepare-button'));
    expect(state.onClickPrepare).toHaveBeenCalledTimes(1);
  });

  it('shows the prepared batch and hands it to the confirm screen', () => {
    const state = logic({
      batch: { psbtHex: '70736274ff', toSignInputs: [] },
      batchSummary: 'consolidation_batch_summary:106|0.05000000|QBT|398827|398.8'
    });
    vi.mocked(useQbitConsolidationScreenLogic).mockReturnValue(state);
    render(<QbitConsolidationScreen />);

    expect(screen.getByTestId('consolidation-batch').textContent).toContain('106');
    expect(screen.queryByTestId('consolidation-prepare-button')).toBeNull();
    fireEvent.click(screen.getByTestId('consolidation-confirm-button'));
    expect(state.onClickConfirm).toHaveBeenCalledTimes(1);
  });

  it('keeps the prepare button disabled when nothing can be prepared', () => {
    vi.mocked(useQbitConsolidationScreenLogic).mockReturnValue(
      logic({ canPrepare: false, error: 'This account is within the explorer output limit.' })
    );
    render(<QbitConsolidationScreen />);

    expect((screen.getByTestId('consolidation-prepare-button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('consolidation-error').textContent).toContain('within the explorer');
  });

  it('wraps an error that holds an unbroken run wider than the popup', () => {
    const error = `HTTP 503 from https://explorer.example/api/address/${'q'.repeat(62)}/txs: Service Unavailable`;
    vi.mocked(useQbitConsolidationScreenLogic).mockReturnValue(logic({ error }));
    render(<QbitConsolidationScreen />);

    const shown = screen.getByTestId('consolidation-error');
    expect(shown.textContent).toBe(error);
    expect(shown.dataset.wrap).toBe('true');
  });
});

describe('QbitConsolidationScreen batch size (#170)', () => {
  afterEach(() => {
    cleanup();
  });

  it('offers the batch size as a labelled field with Max, its range, and the fee of a full batch', () => {
    const state = logic();
    vi.mocked(useQbitConsolidationScreenLogic).mockReturnValue(state);
    render(<QbitConsolidationScreen />);

    const input = screen.getByLabelText('consolidation_batch_size_label') as HTMLInputElement;
    expect(input).toBe(screen.getByTestId('consolidation-batch-size-input'));
    expect(input.value).toBe('106');
    expect(input.getAttribute('inputmode')).toBe('numeric');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(screen.getByTestId('consolidation-batch-size-range').textContent).toBe(
      'consolidation_batch_size_range:2|106'
    );
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe(
      'consolidation_batch_size_range:2|106'
    );
    expect(screen.queryByTestId('consolidation-batch-size-error')).toBeNull();
    expect(screen.queryByTestId('consolidation-cost-note')).toBeNull();
    expect(screen.getByTestId('consolidation-fee-preview').textContent).toBe(
      'consolidation_fee_preview:106|797654|398.8'
    );

    // Max is a real button: the keyboard reaches and presses it.
    const max = screen.getByTestId('consolidation-batch-size-max');
    expect(max.tagName).toBe('BUTTON');
    expect(max.getAttribute('type')).toBe('button');
    expect(max.textContent).toBe('max');
    fireEvent.click(max);
    expect(state.onClickBatchSizeMax).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: '25' } });
    expect(state.onBatchSizeChange).toHaveBeenCalledWith('25');
  });

  it('shows why a size is refused in place of the range, and keeps Prepare disabled', () => {
    vi.mocked(useQbitConsolidationScreenLogic).mockReturnValue(
      logic({
        batchSizeText: '1',
        batchSize: undefined,
        batchSizeError: 'consolidation_batch_size_invalid:2|106',
        statusText: 'consolidation_status_counts:812|500',
        feePreview: '',
        canPrepare: false
      })
    );
    render(<QbitConsolidationScreen />);

    const input = screen.getByTestId('consolidation-batch-size-input');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByTestId('consolidation-batch-size-error').textContent).toBe(
      'consolidation_batch_size_invalid:2|106'
    );
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe(
      'consolidation_batch_size_invalid:2|106'
    );
    expect(screen.queryByTestId('consolidation-batch-size-range')).toBeNull();
    expect(screen.queryByTestId('consolidation-fee-preview')).toBeNull();
    expect((screen.getByTestId('consolidation-prepare-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('notes what a smaller batch adds in fees, and describes the field with it', () => {
    vi.mocked(useQbitConsolidationScreenLogic).mockReturnValue(
      logic({
        batchSizeText: '25',
        batchSize: 25,
        costNote: 'consolidation_cost_note:25|3|106',
        feePreview: 'consolidation_fee_preview:25|188210|94.1'
      })
    );
    render(<QbitConsolidationScreen />);

    expect(screen.getByTestId('consolidation-cost-note').textContent).toBe('consolidation_cost_note:25|3|106');
    const described = screen
      .getByTestId('consolidation-batch-size-input')
      .getAttribute('aria-describedby')!
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(['consolidation_batch_size_range:2|106', 'consolidation_cost_note:25|3|106']);
  });

  it('offers no size until the maximum is known', () => {
    vi.mocked(useQbitConsolidationScreenLogic).mockReturnValue(
      logic({
        showBatchSize: false,
        batchSizeText: '',
        batchSize: undefined,
        maxBatchSize: undefined,
        batchSizeRange: '',
        feePreview: '',
        error: 'HTTP 500'
      })
    );
    render(<QbitConsolidationScreen />);

    expect(screen.queryByTestId('consolidation-batch-size')).toBeNull();
    expect(screen.queryByTestId('consolidation-batch-size-input')).toBeNull();
    expect(screen.getByTestId('consolidation-error').textContent).toBe('HTTP 500');
    // A failed status read does not stop a batch.
    expect((screen.getByTestId('consolidation-prepare-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('prepares, then confirms, with Enter in the field, as the button below does', () => {
    const state = logic();
    vi.mocked(useQbitConsolidationScreenLogic).mockReturnValue(state);
    const { rerender } = render(<QbitConsolidationScreen />);
    const input = screen.getByTestId('consolidation-batch-size-input');

    fireEvent.keyDown(input, { key: '5' });
    fireEvent.keyDown(input, { key: 'Enter', repeat: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(state.onClickPrepare).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(state.onClickPrepare).toHaveBeenCalledTimes(1);
    expect(state.onClickConfirm).not.toHaveBeenCalled();

    // Nothing while Prepare is disabled.
    const disabled = logic({ canPrepare: false });
    vi.mocked(useQbitConsolidationScreenLogic).mockReturnValue(disabled);
    rerender(<QbitConsolidationScreen />);
    fireEvent.keyDown(screen.getByTestId('consolidation-batch-size-input'), { key: 'Enter' });
    expect(disabled.onClickPrepare).not.toHaveBeenCalled();

    // With a batch prepared, Enter goes on to the confirm screen.
    const prepared = logic({ batch: { psbtHex: '70736274ff', toSignInputs: [] } });
    vi.mocked(useQbitConsolidationScreenLogic).mockReturnValue(prepared);
    rerender(<QbitConsolidationScreen />);
    fireEvent.keyDown(screen.getByTestId('consolidation-batch-size-input'), { key: 'Enter' });
    expect(prepared.onClickConfirm).toHaveBeenCalledTimes(1);
    expect(prepared.onClickPrepare).not.toHaveBeenCalled();
  });
});
