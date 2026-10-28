import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, render } from '@testing-library/react';

import { AddressInput } from './AddressInput';

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

describe('AddressInput parent notification', () => {
  afterEach(() => {
    cleanup();
  });

  it('does not report an address while the input is inactive', () => {
    const onAddressInputChange = vi.fn();

    const { container } = render(<AddressInput onAddressInputChange={onAddressInputChange} />);

    expect(container.querySelector('textarea')).toBeNull();
    expect(onAddressInputChange).not.toHaveBeenCalled();
  });

  it('reports the initial address once the input is active', () => {
    const onAddressInputChange = vi.fn();

    const { container } = render(
      <AddressInput addressInputData={{ address: 'qbit1initial' }} onAddressInputChange={onAddressInputChange} />
    );

    expect(container.querySelector('textarea')).not.toBeNull();
    expect(onAddressInputChange).toHaveBeenCalledTimes(1);
    expect(onAddressInputChange).toHaveBeenCalledWith({ address: 'qbit1initial' });
  });
});
