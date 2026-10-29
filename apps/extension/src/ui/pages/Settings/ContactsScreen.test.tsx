import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useChain, useI18n, useNavigation, useTools, useWallet } from '@qbit/wallet-state';
import { ChainType } from '@qbit/wallet-types';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import ContactsScreen from './ContactsScreen';

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) =>
    React.createElement('div', { onClick }, children);
  const Text = ({ text, onClick }: { text?: string; onClick?: () => void }) =>
    React.createElement('span', { onClick }, text);
  // Like the real Button, `loading` also disables it
  const Button = ({
    text,
    onClick,
    disabled,
    loading
  }: {
    text?: string;
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
  }) => React.createElement('button', { onClick, disabled: disabled || loading, 'aria-busy': loading }, text);
  const Header = ({ title }: { title?: string }) => React.createElement('div', null, title);
  const Icon = ({ icon }: { icon?: string }) => React.createElement('i', { 'data-testid': `icon-${icon}` });
  const Image = () => null;
  return {
    Button,
    Card: Container,
    Column: Container,
    Content: Container,
    Footer: Container,
    Header,
    Icon,
    Image,
    Layout: Container,
    Row: Container,
    Text
  };
});

vi.mock('@/ui/components/BottomModal', () => ({ BottomModal: () => null }));
vi.mock('@/shared/constant', () => ({ IMAGE_SOURCE_MAP: {} }));
vi.mock('@/ui/web', () => ({ getUiType: () => ({ isSidePanel: false }) }));
vi.mock('./ContactChainModal', () => ({ ContactChainModal: () => null }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@qbit/wallet-shared', () => ({
  CHAINS_MAP: {
    QBIT_MAINNET: { icon: 'qbit', iconLabel: 'Qbit', label: 'Qbit Mainnet' },
    QBIT_TESTNET4: { icon: 'qbit', iconLabel: 'Testnet4', label: 'Qbit Testnet4' }
  }
}));
vi.mock('@qbit/wallet-state', () => ({
  useChain: vi.fn(),
  useI18n: vi.fn(),
  useNavigation: vi.fn(),
  useTools: vi.fn(),
  useWallet: vi.fn()
}));

const contact = (name: string, sortIndex: number) => ({
  name,
  address: `qb1z${name.toLowerCase()}`,
  chain: ChainType.QBIT_MAINNET,
  isContact: true,
  isAlias: false,
  sortIndex
});
const savedContacts = [contact('Alice', 0), contact('Bob', 1), contact('Carol', 2)];

const shownNames = () => screen.queryAllByText(/^(Alice|Bob|Carol)$/).map((element) => element.textContent);

describe('ContactsScreen', () => {
  const wallet = {
    listContacts: vi.fn(),
    saveContactsOrder: vi.fn()
  };
  const tools = { toastError: vi.fn() };

  beforeEach(() => {
    cleanup();
    wallet.listContacts.mockResolvedValue(savedContacts);
    vi.mocked(useWallet).mockReturnValue(wallet as any);
    vi.mocked(useTools).mockReturnValue(tools as any);
    vi.mocked(useChain).mockReturnValue({ enum: ChainType.QBIT_MAINNET } as any);
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useNavigation).mockReturnValue({ getRouteState: () => ({}), navigate: vi.fn() } as any);
  });

  // Enter sorting mode and move Carol to the top.
  async function moveCarolToTop() {
    render(<ContactsScreen />);
    await waitFor(() => expect(shownNames()).toEqual(['Alice', 'Bob', 'Carol']));

    fireEvent.click(screen.getByTestId('icon-sortAddress'));
    const topButtons = document.querySelectorAll('.top-button');
    expect(topButtons).toHaveLength(2);
    fireEvent.click(topButtons[1]);
    await waitFor(() => expect(shownNames()).toEqual(['Carol', 'Alice', 'Bob']));
  }

  // Enter sorting mode, move Carol to the top and press Finish.
  async function moveCarolToTopAndFinish() {
    await moveCarolToTop();

    fireEvent.click(screen.getByText('finish'));
    await waitFor(() => expect(screen.queryByText('finish')).toBeNull());
  }

  // Saves stay pending until the returned function settles them.
  function holdSaves() {
    const pending: (() => void)[] = [];
    wallet.saveContactsOrder.mockImplementation(() => new Promise<void>((resolve) => pending.push(resolve)));
    return () => act(async () => pending.forEach((resolve) => resolve()));
  }

  it('shows the new order once it is saved', async () => {
    wallet.saveContactsOrder.mockResolvedValue(undefined);

    await moveCarolToTopAndFinish();

    expect(wallet.saveContactsOrder).toHaveBeenCalledWith([savedContacts[2], savedContacts[0], savedContacts[1]]);
    expect(shownNames()).toEqual(['Carol', 'Alice', 'Bob']);
    expect(tools.toastError).not.toHaveBeenCalled();
  });

  it('shows an error and the saved order when saving the new order fails', async () => {
    wallet.saveContactsOrder.mockRejectedValue(new Error('QUOTA_BYTES quota exceeded'));

    await moveCarolToTopAndFinish();

    expect(wallet.saveContactsOrder).toHaveBeenCalledTimes(1);
    expect(tools.toastError).toHaveBeenCalledWith('failed_to_save_contact_order');
    expect(shownNames()).toEqual(['Alice', 'Bob', 'Carol']);
  });

  it('sends one save when Finish is pressed again while the order is being saved', async () => {
    const finishSaves = holdSaves();
    await moveCarolToTop();

    fireEvent.click(screen.getByText('finish'));
    fireEvent.click(screen.getByText('finish'));

    expect(wallet.saveContactsOrder).toHaveBeenCalledTimes(1);
    expect(screen.getByText('finish').getAttribute('aria-busy')).toBe('true');

    await finishSaves();
    await waitFor(() => expect(screen.queryByText('finish')).toBeNull());
    expect(wallet.saveContactsOrder).toHaveBeenCalledTimes(1);
    expect(shownNames()).toEqual(['Carol', 'Alice', 'Bob']);

    // The controls come back for the next reorder
    fireEvent.click(screen.getByTestId('icon-sortAddress'));
    expect(screen.getByText('finish').getAttribute('aria-busy')).not.toBe('true');
  });

  it('ignores Cancel and moves while the order is being saved', async () => {
    const finishSaves = holdSaves();
    await moveCarolToTop();

    fireEvent.click(screen.getByText('finish'));
    fireEvent.click(screen.getByText('cancel'));

    // Still sorting, with the order being saved on screen
    expect(shownNames()).toEqual(['Carol', 'Alice', 'Bob']);
    expect(screen.getByText('finish').getAttribute('aria-busy')).toBe('true');

    fireEvent.click(document.querySelectorAll('.top-button')[1]);
    expect(shownNames()).toEqual(['Carol', 'Alice', 'Bob']);

    await finishSaves();
    await waitFor(() => expect(screen.queryByText('finish')).toBeNull());
    expect(wallet.saveContactsOrder).toHaveBeenCalledTimes(1);
    expect(wallet.saveContactsOrder).toHaveBeenCalledWith([savedContacts[2], savedContacts[0], savedContacts[1]]);
    expect(shownNames()).toEqual(['Carol', 'Alice', 'Bob']);
    expect(tools.toastError).not.toHaveBeenCalled();
  });
});
