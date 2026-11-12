import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { AmountInput } from './AmountInput';

vi.mock('@qbit/wallet-state', () => ({
  useI18n: () => ({ t: (key: string) => key })
}));

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  return {
    Icon: ({ icon, onClick }: { icon: string; onClick?: () => void }) =>
      React.createElement('button', { 'data-testid': `stepper-${icon}`, onClick }),
    Text: ({ text }: { text?: string }) => React.createElement('span', null, text)
  };
});

vi.mock('../Column', () => ({
  Column: ({ children }: { children?: ReactNode }) => <div>{children}</div>
}));

/**
 * The fee bar's Custom rate input: hundredths, stepping by 0.01 from the
 * 0.25 bits/vB relay floor, its value held by the parent as the fee bar holds it.
 */
function RateInput({ initial, onChange }: { initial: string; onChange: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <AmountInput
      preset="amount"
      value={value}
      decimalPlaces={2}
      enableStepper
      step={0.01}
      min={0.25}
      onAmountInputChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

function renderRateInput(initial: string) {
  const onChange = vi.fn();
  const { container } = render(<RateInput initial={initial} onChange={onChange} />);
  const field = container.querySelector('input');
  if (!field) throw new Error('no input rendered');
  return { field, onChange };
}

describe('AmountInput stepper', () => {
  afterEach(() => {
    cleanup();
  });

  it.each([
    ['0.26', 'down', '0.25'],
    ['0.25', 'down', '0.25'],
    ['0.1', 'down', '0.25'],
    ['', 'up', '0.25'],
    ['0.1', 'up', '0.25'],
    ['0.24', 'up', '0.25'],
    ['0.25', 'up', '0.26'],
    ['1', 'down', '0.99']
  ])('steps from "%s" %s to %s, never below the minimum', (initial, direction, expected) => {
    const { field, onChange } = renderRateInput(initial);

    fireEvent.click(screen.getByTestId(`stepper-${direction}`));

    expect(field.value).toBe(expected);
    expect(onChange).toHaveBeenLastCalledWith(expected);
  });

  it('stops at the minimum however often it steps down', () => {
    const { field, onChange } = renderRateInput('0.27');

    for (let step = 0; step < 4; step++) fireEvent.click(screen.getByTestId('stepper-down'));

    expect(field.value).toBe('0.25');
    expect(onChange.mock.calls.map(([value]) => value)).toEqual(['0.27', '0.26', '0.25']);
  });
});
