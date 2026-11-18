import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, render } from '@testing-library/react';

import AddressTypeScreen from './AddressTypeScreen';

const cards = vi.hoisted(() => [] as { label: string; asBalance?: boolean }[]);

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children);
  return { Column: Container, Content: Container, Header: () => null, Layout: Container };
});
vi.mock('@/ui/components/AddressTypeCard', () => ({
  AddressTypeCard: (props: { label: string; asBalance?: boolean }) => {
    cards.push({ label: props.label, asBalance: props.asBalance });
    return null;
  }
}));
vi.mock('@/ui/utils/settingsBack', () => ({ useBackToSettingsParent: () => vi.fn() }));
vi.mock('@qbit/wallet-state', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  useAddressTypeScreenLogic: () => ({
    currentKeyring: { addressType: 0 },
    items: [
      { name: 'Taproot (P2TR)', address: '', value: 2, assets: { totalAmount: '0.00100000', satoshis: 100_000 } },
      { name: 'Post-Quantum P2MR', address: '', value: 0, assets: { totalAmount: '--', satoshis: 0 } }
    ],
    onClickItem: vi.fn()
  })
}));

afterEach(() => {
  cleanup();
  cards.length = 0;
});

describe('AddressTypeScreen', () => {
  it('shows each type’s holding of the account in use as a balance', () => {
    render(<AddressTypeScreen />);

    expect(cards).toEqual([
      { label: 'Taproot (P2TR)', asBalance: true },
      { label: 'Post-Quantum P2MR', asBalance: true }
    ]);
  });
});
