import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render } from '@testing-library/react';

import { Input } from '.';

vi.mock('@qbit/wallet-state', () => ({
  useChain: () => ({ enum: 'QBIT_MAINNET' }),
  useI18n: () => ({ t: (key: string) => key })
}));

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const View = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children);
  return {
    Icon: () => null,
    Row: View,
    Text: ({ text }: { text?: string }) => React.createElement('span', null, text)
  };
});

vi.mock('@/ui/utils/qbit-utils', () => ({ isValidAddress: () => true }));
vi.mock('../ContactsModal', () => ({ ContactsModal: () => null }));

describe('Input key handlers', () => {
  afterEach(() => {
    cleanup();
  });

  it.each(['password', 'text'] as const)('hands a keydown in the %s field to onKeyDown', (preset) => {
    const onKeyDown = vi.fn();

    const { container } = render(<Input preset={preset} onKeyDown={onKeyDown} />);
    const field = container.querySelector('input');
    if (!field) throw new Error('no input rendered');
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(onKeyDown.mock.calls[0][0].key).toBe('Enter');
  });
});
