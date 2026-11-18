import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AddressTypeCard } from '.';

const tools = vi.hoisted(() => ({ toastSuccess: vi.fn() }));
const clipboard = vi.hoisted(() => ({ copyToClipboard: vi.fn(() => Promise.resolve()) }));

vi.mock('@qbit/wallet-state', () => ({
  useChain: () => ({ icon: 'qbitRegtest' }),
  useQbitUnit: () => 'QBT',
  useTools: () => tools,
  useI18n: () => ({ t: (key: string) => key })
}));

vi.mock('@/ui/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui/utils')>()),
  copyToClipboard: clipboard.copyToClipboard
}));

const ADDRESS = 'qbrt1zfjt52emusmwager0jw273stf64emu9uzyr8vjjpgwpmj5ggze60qv7muvy';
const NO_FUNDS = { totalAmount: '--', satoshis: 0 };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Every element of the card clicked, as a user might tap anywhere on it. */
function clickEverything(container: HTMLElement) {
  container.querySelectorAll('*').forEach((element) => fireEvent.click(element));
}

describe('AddressTypeCard', () => {
  it('offers to copy the address it shows', async () => {
    const onClick = vi.fn();
    const { container } = render(
      <AddressTypeCard label="Post-Quantum P2MR" address={ADDRESS} checked assets={NO_FUNDS} onClick={onClick} />
    );

    expect(screen.getByText('qbrt1zfj...0qv7muvy')).toBeTruthy();
    expect(container.querySelectorAll('.lucide-copy').length).toBe(1);

    fireEvent.click(screen.getByText('qbrt1zfj...0qv7muvy'));
    expect(clipboard.copyToClipboard).toHaveBeenCalledWith(ADDRESS);
    await waitFor(() => expect(tools.toastSuccess).toHaveBeenCalledWith('copied'));
  });

  it.each([
    ['none yet', ''],
    ['none read', undefined]
  ])('offers nothing to copy without an address (%s)', async (_case, address) => {
    const onClick = vi.fn();
    const { container } = render(
      <AddressTypeCard
        label="Post-Quantum P2MR"
        address={address as unknown as string}
        checked
        assets={NO_FUNDS}
        onClick={onClick}
      />
    );

    expect(container.querySelectorAll('.lucide-copy').length).toBe(0);
    // The tick of the current type is still there.
    expect(container.querySelectorAll('.lucide-check').length).toBe(1);

    clickEverything(container);
    await Promise.resolve();
    expect(clipboard.copyToClipboard).not.toHaveBeenCalled();
    expect(tools.toastSuccess).not.toHaveBeenCalled();
    // The card itself still answers a tap.
    expect(onClick).toHaveBeenCalled();
  });

  it('shows the holding of the account in use as a balance, with the exact amount on hover and for a screen reader', () => {
    const { container } = render(
      <AddressTypeCard
        label="Post-Quantum P2MR"
        address={ADDRESS}
        checked
        assets={{ totalAmount: '118591.83137906', satoshis: 11_859_183_137_906 }}
        asBalance
      />
    );

    const shown = screen.getByText('118,591.83137 QBT');
    const figure = shown.closest('[aria-hidden="true"]') as HTMLElement;
    expect(figure.getAttribute('title')).toBe('118,591.83137906 QBT');
    const spoken = screen.getByText('118,591.83137906 QBT');
    expect(spoken.closest('[aria-hidden]')).toBeNull();
    expect(container.textContent).not.toContain('118591.83137906');
  });

  it('never shows a holding above zero as zero', () => {
    render(
      <AddressTypeCard
        label="Post-Quantum P2MR"
        address={ADDRESS}
        checked
        assets={{ totalAmount: '0.00000999', satoshis: 999 }}
        asBalance
      />
    );

    expect(screen.getByText('<0.00001 QBT').closest('[title]')?.getAttribute('title')).toBe('0.00000999 QBT');
  });

  it('keeps the eight decimals of a candidate listed before an account exists', () => {
    const { container } = render(
      <AddressTypeCard
        label="Post-Quantum P2MR"
        address={ADDRESS}
        checked={false}
        assets={{ totalAmount: '118591.83137906', satoshis: 11_859_183_137_906 }}
      />
    );

    const shown = screen.getByText('118591.83137906 QBT');
    expect(shown.closest('[title]')).toBeNull();
    expect(shown.closest('[aria-hidden]')).toBeNull();
    expect(container.textContent).not.toContain('118,591');
  });
});
