import type { CSSProperties, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { KeyringType } from '@qbit/keyring-service/types';
import { ErrorCodes } from '@qbit/wallet-shared';
import { useAppDispatch, useI18n, useNavigation, useTools, useWallet } from '@qbit/wallet-state';

import { RemoveWalletPopover } from './index';

async function mockContainer(name: string) {
  const React = await import('react');
  const Container = ({
    children,
    style,
    onClick
  }: {
    children?: ReactNode;
    style?: CSSProperties;
    onClick?: (event: unknown) => void;
  }) => React.createElement('div', { style, onClick }, children);
  return { [name]: Container };
}

vi.mock('../Button', async () => {
  const React = await import('react');
  return {
    Button: ({
      text,
      onClick,
      ...props
    }: {
      text?: string;
      onClick?: (event: unknown) => void;
      'aria-disabled'?: boolean;
      'data-testid'?: string;
    }) =>
      React.createElement(
        'div',
        { onClick, 'aria-disabled': props['aria-disabled'], 'data-testid': props['data-testid'] },
        text
      )
  };
});
vi.mock('../Input', async () => {
  const React = await import('react');
  return {
    Input: ({
      onChange,
      ...props
    }: {
      onChange?: (event: unknown) => void;
      'data-testid'?: string;
    }) => React.createElement('input', { onChange, 'data-testid': props['data-testid'] })
  };
});
vi.mock('../Card', () => mockContainer('Card'));
vi.mock('../Column', () => mockContainer('Column'));
vi.mock('../Popover', () => mockContainer('Popover'));
vi.mock('../Row', () => mockContainer('Row'));
vi.mock('../Text', async () => {
  const React = await import('react');
  return {
    Text: ({ text }: { text?: string }) => React.createElement('span', null, text)
  };
});

vi.mock('@/ui/utils', () => ({
  shortAddress: (value = '') => value
}));

vi.mock('@qbit/wallet-state', () => ({
  accountActions: { setCurrent: (payload: unknown) => ({ type: 'account/setCurrent', payload }) },
  keyringsActions: {
    setKeyrings: (payload: unknown) => ({ type: 'keyrings/setKeyrings', payload }),
    setCurrent: (payload: unknown) => ({ type: 'keyrings/setCurrent', payload })
  },
  useAppDispatch: vi.fn(),
  useI18n: vi.fn(),
  useNavigation: vi.fn(),
  useTools: vi.fn(),
  useWallet: vi.fn()
}));

const account = {
  address: 'tq1qremoved',
  alianName: 'Account 1',
  flag: 0,
  index: 0,
  key: 'keyring_1#0',
  pubkey: 'account-pubkey',
  type: KeyringType.QbitHdKeyring
};
const keyring = {
  accountIndexDerivation: false,
  accounts: [account],
  addressType: 9,
  alianName: 'Wallet 2',
  hdPath: `m/87'/1'/0'/0`,
  index: 1,
  key: 'keyring_1',
  type: KeyringType.QbitHdKeyring
};

describe('RemoveWalletPopover remove action', () => {
  const dispatch = vi.fn();
  const navigate = vi.fn();
  const toastError = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    vi.mocked(useAppDispatch).mockReturnValue(dispatch as any);
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useNavigation).mockReturnValue({ navigate } as any);
    vi.mocked(useTools).mockReturnValue({ toastError } as any);
  });

  it('surfaces a background refusal instead of silently doing nothing', async () => {
    vi.mocked(useWallet).mockReturnValue({
      removeKeyring: vi.fn().mockRejectedValue({ message: 'qbit_recovery_wallets_retained' }),
      getKeyrings: vi.fn()
    } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('qbit_recovery_wallets_retained'));
    expect(onClose).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('falls back to a generic error when the rejection carries no message', async () => {
    vi.mocked(useWallet).mockReturnValue({
      removeKeyring: vi.fn().mockRejectedValue({}),
      getKeyrings: vi.fn()
    } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('unknown_error'));
    expect(onClose).toHaveBeenCalled();
  });

  it('updates keyring state without toasting when removal succeeds', async () => {
    const nextKeyring = { ...keyring, index: 0, key: 'keyring_0', accounts: [account] };
    vi.mocked(useWallet).mockReturnValue({
      removeKeyring: vi.fn().mockResolvedValue(nextKeyring),
      getKeyrings: vi.fn().mockResolvedValue([nextKeyring])
    } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: 'keyrings/setKeyrings', payload: [nextKeyring] })
    );
    expect(dispatch).toHaveBeenCalledWith({ type: 'account/setCurrent', payload: account });
    expect(toastError).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not report a refused removal when the post-removal refresh fails', async () => {
    const nextKeyring = { ...keyring, index: 0, key: 'keyring_0', accounts: [account] };
    vi.mocked(useWallet).mockReturnValue({
      removeKeyring: vi.fn().mockResolvedValue(nextKeyring),
      getKeyrings: vi.fn().mockRejectedValue(new Error('background unreachable'))
    } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: 'account/setCurrent', payload: account })
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'keyrings/setKeyrings' })
    );
    expect(toastError).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('closes without dispatching when the refresh fails and no next keyring exists', async () => {
    vi.mocked(useWallet).mockReturnValue({
      removeKeyring: vi.fn().mockResolvedValue(undefined),
      getKeyrings: vi.fn().mockRejectedValue(new Error('background unreachable'))
    } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(dispatch).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  const ackRequiredError = {
    code: ErrorCodes.QBIT_RECOVERY_REMOVAL_ACK_REQUIRED,
    message: 'qbit_recovery_wallets_retained',
    data: {
      reasons: [{ role: 'destination', network: 'regtest', status: 'migrating', hasInflightPlans: true }]
    }
  };

  it('shows the recovery risk step instead of toasting when confirmation is required', async () => {
    const removeKeyring = vi.fn().mockRejectedValue(ackRequiredError);
    vi.mocked(useWallet).mockReturnValue({ removeKeyring, getKeyrings: vi.fn() } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_title')).toBeTruthy());
    expect(screen.getByText('qbit_recovery_removal_destination')).toBeTruthy();
    expect(screen.getByText('qbit_recovery_removal_inflight')).toBeTruthy();
    expect(removeKeyring).toHaveBeenCalledTimes(1);
    expect(removeKeyring).toHaveBeenCalledWith(keyring, undefined);
    expect(toastError).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('maps each reason onto its risk line and falls back when detail is missing', async () => {
    const removeKeyring = vi.fn().mockRejectedValue({
      ...ackRequiredError,
      data: {
        reasons: [
          { role: 'source', network: 'regtest', status: 'migrating' },
          { role: 'source', network: 'mainnet', status: 'migrated' }
        ]
      }
    });
    vi.mocked(useWallet).mockReturnValue({ removeKeyring, getKeyrings: vi.fn() } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_source_migrating')).toBeTruthy());
    expect(screen.getByText('qbit_recovery_removal_source_migrated')).toBeTruthy();
    expect(screen.queryByText('qbit_recovery_removal_destination')).toBeNull();

    cleanup();
    const detailFreeRemove = vi.fn().mockRejectedValue({ ...ackRequiredError, data: undefined });
    vi.mocked(useWallet).mockReturnValue({ removeKeyring: detailFreeRemove, getKeyrings: vi.fn() } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));

    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_unverified')).toBeTruthy());
  });

  it('sends the acknowledged removal only after the typed agreement', async () => {
    const nextKeyring = { ...keyring, index: 0, key: 'keyring_0', accounts: [account] };
    const removeKeyring = vi
      .fn()
      .mockRejectedValueOnce(ackRequiredError)
      .mockResolvedValueOnce(nextKeyring);
    vi.mocked(useWallet).mockReturnValue({
      removeKeyring,
      getKeyrings: vi.fn().mockResolvedValue([nextKeyring])
    } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));
    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_title')).toBeTruthy());

    fireEvent.click(screen.getByTestId('recovery-removal-confirm-button'));
    expect(removeKeyring).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByTestId('recovery-removal-confirmation-input'), {
      target: { value: 'confirm' }
    });
    await waitFor(() =>
      expect(screen.getByTestId('recovery-removal-confirm-button').getAttribute('aria-disabled')).toBe('false')
    );
    fireEvent.click(screen.getByTestId('recovery-removal-confirm-button'));

    await waitFor(() => expect(removeKeyring).toHaveBeenCalledTimes(2));
    // The retry carries the displayed reason set so the background can spot
    // risks that appeared while the warning was open.
    expect(removeKeyring).toHaveBeenLastCalledWith(keyring, {
      acknowledgedQbitRecoveryRisks: true,
      acknowledgedQbitRecoveryReasons: ackRequiredError.data.reasons
    });
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: 'keyrings/setKeyrings', payload: [nextKeyring] })
    );
    expect(dispatch).toHaveBeenCalledWith({ type: 'account/setCurrent', payload: account });
    expect(toastError).not.toHaveBeenCalled();
  });

  it('re-prompts with the refreshed reasons when the acknowledged removal is refused again', async () => {
    const removeKeyring = vi
      .fn()
      .mockRejectedValueOnce(ackRequiredError)
      .mockRejectedValueOnce({
        ...ackRequiredError,
        data: {
          reasons: [{ role: 'source', network: 'regtest', status: 'migrating', hasInflightPlans: true }]
        }
      });
    vi.mocked(useWallet).mockReturnValue({ removeKeyring, getKeyrings: vi.fn() } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));
    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_destination')).toBeTruthy());

    fireEvent.change(screen.getByTestId('recovery-removal-confirmation-input'), {
      target: { value: 'CONFIRM' }
    });
    fireEvent.click(screen.getByTestId('recovery-removal-confirm-button'));

    // The risks changed while the warning was open: the popover shows the
    // refreshed lines and demands a fresh typed confirmation instead of
    // closing over the new risk.
    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_source_migrating')).toBeTruthy());
    expect(removeKeyring).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(screen.getByTestId('recovery-removal-confirm-button').getAttribute('aria-disabled')).toBe('true');
  });

  it('cancels the risk step without retrying the removal', async () => {
    const removeKeyring = vi.fn().mockRejectedValue(ackRequiredError);
    vi.mocked(useWallet).mockReturnValue({ removeKeyring, getKeyrings: vi.fn() } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));
    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_title')).toBeTruthy());

    fireEvent.click(screen.getByText('cancel'));
    expect(onClose).toHaveBeenCalled();
    expect(removeKeyring).toHaveBeenCalledTimes(1);
  });

  it('sends a single removal no matter how fast remove is clicked twice', async () => {
    let resolveRemoval: (value: unknown) => void = () => undefined;
    const removeKeyring = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveRemoval = resolve)));
    vi.mocked(useWallet).mockReturnValue({
      removeKeyring,
      getKeyrings: vi.fn().mockResolvedValue([])
    } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));
    fireEvent.click(screen.getByText('remove'));
    expect(removeKeyring).toHaveBeenCalledTimes(1);

    resolveRemoval(undefined);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('WelcomeScreen'));
    expect(removeKeyring).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('ignores a second confirm click while the acknowledged removal is in flight', async () => {
    const nextKeyring = { ...keyring, index: 0, key: 'keyring_0', accounts: [account] };
    let resolveRemoval: (value: unknown) => void = () => undefined;
    const removeKeyring = vi
      .fn()
      .mockRejectedValueOnce(ackRequiredError)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveRemoval = resolve)));
    vi.mocked(useWallet).mockReturnValue({
      removeKeyring,
      getKeyrings: vi.fn().mockResolvedValue([nextKeyring])
    } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));
    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_title')).toBeTruthy());

    fireEvent.change(screen.getByTestId('recovery-removal-confirmation-input'), {
      target: { value: 'CONFIRM' }
    });
    fireEvent.click(screen.getByTestId('recovery-removal-confirm-button'));
    fireEvent.click(screen.getByTestId('recovery-removal-confirm-button'));
    // One unacknowledged probe plus exactly one acknowledged removal.
    expect(removeKeyring).toHaveBeenCalledTimes(2);

    resolveRemoval(nextKeyring);
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: 'keyrings/setKeyrings', payload: [nextKeyring] })
    );
    expect(removeKeyring).toHaveBeenCalledTimes(2);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('keeps cancel inert while the acknowledged removal is in flight', async () => {
    const nextKeyring = { ...keyring, index: 0, key: 'keyring_0', accounts: [account] };
    let resolveRemoval: (value: unknown) => void = () => undefined;
    const removeKeyring = vi
      .fn()
      .mockRejectedValueOnce(ackRequiredError)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveRemoval = resolve)));
    vi.mocked(useWallet).mockReturnValue({
      removeKeyring,
      getKeyrings: vi.fn().mockResolvedValue([nextKeyring])
    } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));
    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_title')).toBeTruthy());

    fireEvent.change(screen.getByTestId('recovery-removal-confirmation-input'), {
      target: { value: 'CONFIRM' }
    });
    fireEvent.click(screen.getByTestId('recovery-removal-confirm-button'));
    fireEvent.click(screen.getByTestId('recovery-removal-cancel-button'));
    expect(onClose).not.toHaveBeenCalled();

    resolveRemoval(nextKeyring);
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: 'account/setCurrent', payload: account })
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('toasts and closes when the acknowledged removal itself fails', async () => {
    const removeKeyring = vi
      .fn()
      .mockRejectedValueOnce(ackRequiredError)
      .mockRejectedValueOnce({ message: 'vault sealed' });
    vi.mocked(useWallet).mockReturnValue({ removeKeyring, getKeyrings: vi.fn() } as any);

    render(<RemoveWalletPopover keyring={keyring as any} onClose={onClose} />);
    fireEvent.click(screen.getByText('remove'));
    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_title')).toBeTruthy());

    fireEvent.change(screen.getByTestId('recovery-removal-confirmation-input'), {
      target: { value: 'CONFIRM' }
    });
    fireEvent.click(screen.getByTestId('recovery-removal-confirm-button'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('vault sealed'));
    expect(onClose).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
