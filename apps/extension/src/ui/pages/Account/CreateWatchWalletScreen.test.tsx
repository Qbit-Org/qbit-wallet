import type { ChangeEventHandler, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useI18n, useTools, useWallet } from '@qbit/wallet-state';

import CreateWatchWalletScreen from './CreateWatchWalletScreen';

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children);
  return {
    Button: ({ text, onClick, disabled }: { text?: string; onClick?: () => void; disabled?: boolean }) =>
      React.createElement('button', { onClick, disabled }, text),
    Column: Container,
    Content: Container,
    Header: ({ title }: { title?: string }) => React.createElement('header', null, title),
    Input: ({ onChange, placeholder }: { onChange?: ChangeEventHandler<HTMLInputElement>; placeholder?: string }) =>
      React.createElement('input', { onChange, placeholder }),
    Layout: Container
  };
});
vi.mock('@/ui/components/FooterButtonContainer', async () => {
  const React = await import('react');
  return {
    FooterButtonContainer: ({ children }: { children?: ReactNode }) => React.createElement('div', null, children)
  };
});
const navigate = vi.fn();
vi.mock('../MainRoute', () => ({ useNavigate: () => navigate }));
vi.mock('@qbit/wallet-state', () => ({
  useI18n: vi.fn(),
  useTools: vi.fn(),
  useWallet: vi.fn()
}));

// Rejections reach the page as plain objects, not Errors: the toast shows
// their message, or unknown_error, and never "[object Object]" or nothing.
describe.each([
  [
    'a plain rejection with a message',
    { code: -32603, message: 'Address is already watched' },
    'Address is already watched'
  ],
  ['a plain rejection without a message', { code: -32603 }, 'unknown_error']
])('CreateWatchWalletScreen, %s', (_name, rejection, shown) => {
  const toastError = vi.fn();
  const createTmpKeyringWithAddress = vi.fn();
  const createKeyringWithAddress = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as unknown as ReturnType<typeof useI18n>);
    vi.mocked(useTools).mockReturnValue({ toastError } as unknown as ReturnType<typeof useTools>);
    vi.mocked(useWallet).mockReturnValue({
      createTmpKeyringWithAddress,
      createKeyringWithAddress
    } as unknown as ReturnType<typeof useWallet>);
    createTmpKeyringWithAddress.mockResolvedValue({ accounts: [{ address: 'qb1watched' }] });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows it when the wallet cannot be created', async () => {
    createKeyringWithAddress.mockRejectedValue(rejection);
    render(<CreateWatchWalletScreen />);
    fireEvent.change(screen.getByPlaceholderText('watch_address_placeholder'), { target: { value: 'qb1watched' } });

    fireEvent.click(screen.getByText('continue'));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls.map(([text]) => text)).toEqual([shown]);
    expect(toastError).not.toHaveBeenCalledWith('[object Object]');
    expect(navigate).not.toHaveBeenCalled();
  });
});
