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
    Text: ({ text, ...props }: any) => React.createElement('span', props, text)
  };
});

vi.mock('@/ui/components/FeeRateBar', () => ({ FeeRateBar: () => <div>fee-rate-bar</div> }));

function logic(overrides: Partial<ReturnType<typeof useQbitConsolidationScreenLogic>> = {}) {
  return {
    headerTitle: 'consolidate_outputs',
    description: 'consolidation_description',
    status: undefined,
    statusText: 'consolidation_status:812|500|3',
    pendingText: '',
    overLimit: true,
    batch: undefined,
    batchSummary: '',
    error: '',
    preparing: false,
    canPrepare: true,
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

    expect(screen.getByTestId('consolidation-status').textContent).toBe('consolidation_status:812|500|3');
    expect(screen.queryByTestId('consolidation-confirm-button')).toBeNull();
    fireEvent.click(screen.getByTestId('consolidation-prepare-button'));
    expect(state.onClickPrepare).toHaveBeenCalledTimes(1);
  });

  it('shows the prepared batch and hands it to the confirm screen', () => {
    const state = logic({
      batch: { psbtHex: '70736274ff', toSignInputs: [] },
      batchSummary: 'consolidation_batch_summary:106|0.05000000|QBT|398870|398.9'
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
});
