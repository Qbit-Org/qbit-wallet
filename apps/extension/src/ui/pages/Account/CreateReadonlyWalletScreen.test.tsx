import type { ChangeEventHandler, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useI18n, useTools, useWallet } from '@qbit/wallet-state';

import CreateReadonlyWalletScreen from './CreateReadonlyWalletScreen';

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children);
  return {
    Button: ({
      text,
      onClick,
      disabled,
      'data-testid': dataTestId
    }: {
      text?: string;
      onClick?: () => void;
      disabled?: boolean;
      'data-testid'?: string;
    }) => React.createElement('button', { onClick, disabled, 'data-testid': dataTestId }, text),
    Column: Container,
    Content: Container,
    Header: ({ title }: { title?: string }) => React.createElement('header', null, title),
    Input: ({
      onChange,
      'data-testid': dataTestId
    }: {
      onChange?: ChangeEventHandler<HTMLInputElement>;
      'data-testid'?: string;
    }) => React.createElement('input', { onChange, 'data-testid': dataTestId }),
    Layout: Container,
    Row: Container,
    Text: ({ text }: { text?: string }) => React.createElement('span', null, text)
  };
});
vi.mock('@/ui/components/AddressTypeCard', () => ({ AddressTypeCard: () => null }));
vi.mock('@/ui/components/FooterButtonContainer', async () => {
  const React = await import('react');
  return {
    FooterButtonContainer: ({ children }: { children?: ReactNode }) => React.createElement('div', null, children)
  };
});
vi.mock('@/ui/components/TabBar', () => ({ TabBar: () => null }));
vi.mock('@/ui/utils', async () => ({
  satoshisToAmount: () => '0',
  // The real helper: the screen's toasts depend on what it makes of a rejection.
  walletErrorMessage: (await vi.importActual<typeof import('@/ui/utils')>('@/ui/utils')).walletErrorMessage
}));
const navigate = vi.fn();
vi.mock('../MainRoute', () => ({ useNavigate: () => navigate }));
vi.mock('@qbit/wallet-state', () => ({
  useI18n: vi.fn(),
  useTools: vi.fn(),
  useWallet: vi.fn()
}));

const PUBKEY = '02'.padEnd(66, 'ab');

// Rejections reach the page as plain objects, not Errors: the toast shows
// their message, or unknown_error, and never "[object Object]" or nothing.
describe.each([
  ['a plain rejection with a message', { code: -32603, message: 'Explorer unavailable' }, 'Explorer unavailable'],
  ['a plain rejection without a message', { code: -32603 }, 'unknown_error']
])('CreateReadonlyWalletScreen, %s', (_name, rejection, shown) => {
  const toastError = vi.fn();
  const createTmpKeyringWithPublicKey = vi.fn();
  const getMultiAddressSummaries = vi.fn();
  const createKeyringWithPublicKey = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as unknown as ReturnType<typeof useI18n>);
    vi.mocked(useTools).mockReturnValue({ toastError } as unknown as ReturnType<typeof useTools>);
    vi.mocked(useWallet).mockReturnValue({
      createTmpKeyringWithPublicKey,
      getMultiAddressSummaries,
      createKeyringWithPublicKey
    } as unknown as ReturnType<typeof useWallet>);
    createTmpKeyringWithPublicKey.mockImplementation(async (_pubkey: string, addressType: number) => ({
      accounts: [{ address: `address-${addressType}` }]
    }));
    getMultiAddressSummaries.mockImplementation(async (addresses: string) =>
      addresses.split(',').map(() => ({ totalSatoshis: 0 }))
    );
  });

  afterEach(() => {
    cleanup();
  });

  const toAddressTypes = async () => {
    render(<CreateReadonlyWalletScreen />);
    fireEvent.change(screen.getByTestId('readonly-public-key-input'), { target: { value: PUBKEY } });
    fireEvent.click(screen.getByTestId('readonly-public-key-continue-button'));
    await screen.findByTestId('readonly-address-type-continue-button');
  };
  const shownOnly = () => {
    expect(toastError.mock.calls.map(([text]) => text)).toEqual([shown]);
    expect(toastError).not.toHaveBeenCalledWith('[object Object]');
  };

  it('shows it when the preview of the addresses is refused', async () => {
    getMultiAddressSummaries.mockRejectedValue(rejection);

    await toAddressTypes();

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    shownOnly();
  });

  it('shows it when the wallet cannot be created', async () => {
    createKeyringWithPublicKey.mockRejectedValue(rejection);
    await toAddressTypes();
    await waitFor(() => expect(getMultiAddressSummaries).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('readonly-address-type-continue-button'));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    shownOnly();
    expect(navigate).not.toHaveBeenCalled();
  });
});
