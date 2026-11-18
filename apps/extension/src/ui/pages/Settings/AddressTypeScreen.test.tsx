import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, render, screen } from '@testing-library/react';

import AddressTypeScreen from './AddressTypeScreen';

// What the screen's hook answers; each test sets whether balances are hidden.
const logic = vi.hoisted(() => ({ balanceHidden: false }));

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children);
  return { Column: Container, Content: Container, Header: () => null, Layout: Container };
});
vi.mock('@/ui/utils/settingsBack', () => ({ useBackToSettingsParent: () => vi.fn() }));
vi.mock('@qbit/wallet-state', () => ({
  useChain: () => ({ icon: 'qbitRegtest' }),
  useI18n: () => ({ t: (key: string) => key }),
  useQbitUnit: () => 'QBT',
  useTools: () => ({ toastSuccess: vi.fn() }),
  useAddressTypeScreenLogic: () => ({
    currentKeyring: { addressType: 2 },
    items: [
      // 131.31313131 coins, and a type that holds nothing.
      {
        name: 'Taproot (P2TR)',
        address: '',
        value: 2,
        assets: { totalAmount: '131.31313131', satoshis: 13_131_313_131 }
      },
      { name: 'Post-Quantum P2MR', address: '', value: 0, assets: { totalAmount: '0.00000000', satoshis: 0 } }
    ],
    balanceHidden: logic.balanceHidden,
    onClickItem: vi.fn()
  })
}));

afterEach(() => {
  cleanup();
  logic.balanceHidden = false;
});

describe('AddressTypeScreen', () => {
  it('shows each type’s holding of the account in use as a balance, with the exact amount', () => {
    render(<AddressTypeScreen />);

    const shown = screen.getByText('131.31313 QBT');
    expect(shown.closest('[title]')?.getAttribute('title')).toBe('131.31313131 QBT');
    expect(screen.getByText('131.31313131 QBT').closest('[aria-hidden]')).toBeNull();
    // A type that holds nothing shows no amount.
    expect(screen.queryByText('****', { exact: false })).toBeNull();
  });

  it('shows **** on every card, and no digit of an amount anywhere, while balances are hidden; the amounts once shown again', () => {
    logic.balanceHidden = true;
    const { container, rerender } = render(<AddressTypeScreen />);

    expect(screen.getAllByText('**** QBT')).toHaveLength(2);
    // Text, titles, labels and text for a screen reader alike.
    expect(container.innerHTML).not.toMatch(/131|313|\d\.\d/);
    expect(container.querySelector('[title]')).toBeNull();

    logic.balanceHidden = false;
    rerender(<AddressTypeScreen />);
    expect(screen.queryByText('**** QBT')).toBeNull();
    expect(screen.getByText('131.31313 QBT').closest('[title]')?.getAttribute('title')).toBe('131.31313131 QBT');
  });
});
