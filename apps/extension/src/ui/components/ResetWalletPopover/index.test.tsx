import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ErrorCodes, type QbitRecoveryRemovalReason } from '@qbit/wallet-shared';

import { WalletResetNotice } from '../WalletResetNotice';
import { createWalletResetHandler, installWalletResetHandler, WALLET_RESET_NOTICE_KEY } from '@/ui/utils/walletReset';
import { ResetWalletPopover } from './index';

const harness = vi.hoisted(() => ({}) as { resetWallet: Mock; isBooted: Mock; toastError: Mock });

vi.mock('@qbit/wallet-state', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  // As the hook does: the one page-side call of the background's resetWallet.
  useResetWallet: () => (password: string, options?: unknown) => harness.resetWallet(password, options),
  useTools: () => ({ toastError: harness.toastError }),
  useWallet: () => ({ isBooted: () => harness.isBooted() })
}));

// The real Input pulls in the whole component library, which needs the
// extension's browser APIs; a plain input with the same props stands in.
vi.mock('@/ui/components/Input', async () => {
  const React = await import('react');
  return {
    Input: ({ preset: _preset, ...props }: { preset?: string } & Record<string, unknown>) =>
      React.createElement('input', props)
  };
});

const PASSWORD = 'correct horse';
const ackRequired = (reasons: QbitRecoveryRemovalReason[]) => ({
  code: ErrorCodes.QBIT_RECOVERY_REMOVAL_ACK_REQUIRED,
  message: 'qbit_recovery_removal_ack_required',
  data: { reasons }
});
const destinationReasons: QbitRecoveryRemovalReason[] = [
  { role: 'destination', network: 'regtest', status: 'migrating', hasInflightPlans: true } as QbitRecoveryRemovalReason
];
const sourceReasons: QbitRecoveryRemovalReason[] = [
  { role: 'source', network: 'regtest', status: 'migrating' } as QbitRecoveryRemovalReason
];

// The port's own rejection when the connection carrying a request closes.
const lostRequest = {
  code: 4900,
  message: 'The connection to Qbit Wallet closed before the request finished, so it may have run.'
};

const confirmButton = () => screen.getByTestId('reset-wallet-confirm-button');
// Every way Enter in a field could send: its key events, with key and key
// codes set as a browser sets them, and the submission of a form around it,
// which jsdom does not perform on Enter by itself.
const pressEnter = (field: HTMLElement) => {
  const enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 13 };
  fireEvent.keyDown(field, enter);
  fireEvent.keyPress(field, enter);
  fireEvent.keyUp(field, enter);
  const form = field.closest('form');
  if (form) fireEvent.submit(form);
};
const typePassword = (value: string) =>
  fireEvent.change(screen.getByTestId('reset-wallet-password-input'), { target: { value } });
const pending = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

describe('ResetWalletPopover', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    harness.resetWallet = vi.fn();
    // Unless a test says otherwise, the background still has its wallets.
    harness.isBooted = vi.fn().mockResolvedValue(true);
    harness.toastError = vi.fn();
    onClose.mockReset();
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('says what a reset erases and keeps, and asks for the current password', () => {
    render(<ResetWalletPopover onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: 'reset_wallet' })).toBeTruthy();
    for (const key of [
      'reset_wallet_erases',
      'reset_wallet_keeps',
      'reset_wallet_restore_warning',
      'this_action_is_not_reversible'
    ]) {
      expect(screen.getByText(key)).toBeTruthy();
    }
    const input = screen.getByTestId('reset-wallet-password-input') as HTMLInputElement;
    expect(input.getAttribute('placeholder')).toBe('current_password');
    expect(document.activeElement).toBe(input);
    // Opened from Settings → Security, it does not speak of a last wallet.
    expect(screen.queryByTestId('reset-wallet-last-wallet')).toBeNull();
  });

  it('explains that removing the last wallet resets the extension when opened from the switcher', () => {
    render(<ResetWalletPopover lastWalletKey="keyring_0" onClose={onClose} />);

    expect(screen.getByTestId('reset-wallet-last-wallet').textContent).toBe('reset_wallet_last_wallet');
    expect(screen.getByText('reset_wallet_erases')).toBeTruthy();
  });

  it('keeps confirm disabled until a password is entered', () => {
    render(<ResetWalletPopover onClose={onClose} />);

    expect(confirmButton().getAttribute('aria-disabled')).toBe('true');
    expect(confirmButton().tabIndex).toBe(-1);
    fireEvent.click(confirmButton());
    fireEvent.keyDown(confirmButton(), { key: 'Enter' });
    expect(harness.resetWallet).not.toHaveBeenCalled();

    typePassword(PASSWORD);
    expect(confirmButton().getAttribute('aria-disabled')).toBe('false');
    expect(confirmButton().tabIndex).toBe(0);

    typePassword('');
    expect(confirmButton().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(confirmButton());
    expect(harness.resetWallet).not.toHaveBeenCalled();
  });

  it('sends nothing while the password is typed, Enter included', () => {
    render(<ResetWalletPopover onClose={onClose} />);

    typePassword(PASSWORD);
    // Confirm is enabled, so only the button stands between Enter and a reset.
    expect(confirmButton().getAttribute('aria-disabled')).toBe('false');
    pressEnter(screen.getByTestId('reset-wallet-password-input'));
    pressEnter(screen.getByRole('dialog', { name: 'reset_wallet' }));

    expect(harness.resetWallet).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('gives the password field a name and announces a refusal', async () => {
    harness.resetWallet.mockRejectedValueOnce({ message: 'Password is incorrect' });
    render(<ResetWalletPopover onClose={onClose} />);

    const field = screen.getByLabelText('current_password');
    expect(field).toBe(screen.getByTestId('reset-wallet-password-input'));
    expect(screen.getByRole('alert').textContent).toBe('');
    fireEvent.change(field, { target: { value: 'wrong' } });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Password is incorrect'));
  });

  it('closes on Cancel and on Escape without calling anything', () => {
    render(<ResetWalletPopover onClose={onClose} />);
    typePassword(PASSWORD);

    fireEvent.click(screen.getByTestId('reset-wallet-cancel-button'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'reset_wallet' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByTestId('popover-close'));
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(harness.resetWallet).not.toHaveBeenCalled();
  });

  it('keeps Tab inside the dialog', () => {
    render(<ResetWalletPopover onClose={onClose} />);
    typePassword(PASSWORD);
    const dialog = screen.getByRole('dialog', { name: 'reset_wallet' });

    confirmButton().focus();
    fireEvent.keyDown(confirmButton(), { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByTestId('reset-wallet-password-input'));

    fireEvent.keyDown(screen.getByTestId('reset-wallet-password-input'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirmButton());
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('calls resetWallet once with the typed password, however fast confirm is pressed twice', async () => {
    const answer = pending<void>();
    harness.resetWallet.mockReturnValue(answer.promise);
    render(<ResetWalletPopover onClose={onClose} />);
    typePassword(PASSWORD);

    fireEvent.click(confirmButton());
    fireEvent.click(confirmButton());
    fireEvent.keyDown(confirmButton(), { key: 'Enter' });

    expect(harness.resetWallet).toHaveBeenCalledTimes(1);
    expect(harness.resetWallet).toHaveBeenCalledWith(PASSWORD, undefined);
    // Pending: nothing can be pressed, and neither Cancel nor Escape closes it.
    expect(confirmButton().getAttribute('aria-disabled')).toBe('true');
    expect((screen.getByTestId('reset-wallet-password-input') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('reset-wallet-cancel-button'));
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'reset_wallet' }), { key: 'Escape' });
    expect(screen.queryByTestId('popover-close')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => answer.resolve());
    expect(harness.resetWallet).toHaveBeenCalledTimes(1);
    // Erased: the window reopens on Welcome, so the dialog stays as it is.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows a wrong password inline, keeps the dialog open and lets the user try again', async () => {
    harness.resetWallet.mockRejectedValueOnce({ message: 'Password is incorrect' });
    render(<ResetWalletPopover onClose={onClose} />);
    typePassword('wrong');

    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.getByTestId('reset-wallet-error').textContent).toBe('Password is incorrect'));
    // Asked first: the background still has its wallets.
    expect(harness.isBooted).toHaveBeenCalledTimes(1);
    expect(harness.resetWallet).toHaveBeenCalledTimes(1);
    expect(harness.toastError).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'reset_wallet' })).toBeTruthy();
    expect(confirmButton().getAttribute('aria-disabled')).toBe('false');

    // Correcting the password clears the message; a new attempt goes out.
    harness.resetWallet.mockReturnValueOnce(new Promise(() => undefined));
    typePassword(PASSWORD);
    expect(screen.queryByTestId('reset-wallet-error')).toBeNull();
    fireEvent.click(confirmButton());
    expect(harness.resetWallet).toHaveBeenCalledTimes(2);
    expect(harness.resetWallet).toHaveBeenLastCalledWith(PASSWORD, undefined);
  });

  it.each([
    ['without a message', { code: -32603 }],
    ['that is no object', undefined],
    ['that is a bare string', 'boom']
  ])('shows a generic message for a refusal %s', async (_name, rejection) => {
    harness.resetWallet.mockRejectedValueOnce(rejection);
    render(<ResetWalletPopover onClose={onClose} />);
    typePassword(PASSWORD);

    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.getByTestId('reset-wallet-error').textContent).toBe('unknown_error'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the recovery risk lines and needs the typed confirmation before it asks again', async () => {
    harness.resetWallet
      .mockRejectedValueOnce(ackRequired(destinationReasons))
      .mockReturnValueOnce(new Promise(() => undefined));
    render(<ResetWalletPopover onClose={onClose} />);
    typePassword(PASSWORD);

    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.getByText('reset_wallet_recovery_title')).toBeTruthy());
    expect(screen.getByText('qbit_recovery_removal_destination')).toBeTruthy();
    expect(screen.getByText('qbit_recovery_removal_inflight')).toBeTruthy();
    expect(screen.getByText('enter “CONFIRM” to_proceed')).toBeTruthy();
    // Nothing is sent again until the confirmation is typed.
    expect(harness.resetWallet).toHaveBeenCalledTimes(1);
    expect(confirmButton().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(confirmButton());
    fireEvent.change(screen.getByTestId('reset-wallet-recovery-confirmation-input'), { target: { value: 'CONFIR' } });
    fireEvent.click(confirmButton());
    expect(harness.resetWallet).toHaveBeenCalledTimes(1);
    expect(harness.toastError).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('reset-wallet-recovery-confirmation-input'), { target: { value: 'confirm' } });
    expect(confirmButton().getAttribute('aria-disabled')).toBe('false');
    // Enter in the confirmation field does not send it either.
    pressEnter(screen.getByTestId('reset-wallet-recovery-confirmation-input'));
    expect(harness.resetWallet).toHaveBeenCalledTimes(1);
    // A refusal that asks for the acknowledgement needs no question back.
    expect(harness.isBooted).not.toHaveBeenCalled();
    fireEvent.click(confirmButton());

    expect(harness.resetWallet).toHaveBeenCalledTimes(2);
    // The retry carries the reasons shown, so the background can spot risks
    // that appeared while the warning was open.
    expect(harness.resetWallet).toHaveBeenLastCalledWith(PASSWORD, {
      acknowledgedQbitRecoveryRisks: true,
      acknowledgedQbitRecoveryReasons: destinationReasons
    });
  });

  it('shows the new risks, and needs a fresh confirmation, when the acknowledged reset is refused again', async () => {
    harness.resetWallet
      .mockRejectedValueOnce(ackRequired(destinationReasons))
      .mockRejectedValueOnce(ackRequired(sourceReasons));
    render(<ResetWalletPopover onClose={onClose} />);
    typePassword(PASSWORD);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_destination')).toBeTruthy());

    fireEvent.change(screen.getByTestId('reset-wallet-recovery-confirmation-input'), { target: { value: 'CONFIRM' } });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_source_migrating')).toBeTruthy());
    expect(screen.queryByText('qbit_recovery_removal_destination')).toBeNull();
    expect(harness.resetWallet).toHaveBeenCalledTimes(2);
    expect((screen.getByTestId('reset-wallet-recovery-confirmation-input') as HTMLInputElement).value).toBe('');
    expect(confirmButton().getAttribute('aria-disabled')).toBe('true');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the broadest risk when the background gives no detail', async () => {
    harness.resetWallet.mockRejectedValueOnce({
      code: ErrorCodes.QBIT_RECOVERY_REMOVAL_ACK_REQUIRED,
      data: { reasons: 'none' }
    });
    render(<ResetWalletPopover onClose={onClose} />);
    typePassword(PASSWORD);
    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_unverified')).toBeTruthy());
  });

  it('reads a reason that is not an object as the broadest risk', async () => {
    harness.resetWallet.mockRejectedValueOnce(
      ackRequired([null, ...destinationReasons] as QbitRecoveryRemovalReason[])
    );
    render(<ResetWalletPopover onClose={onClose} />);
    typePassword(PASSWORD);
    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.getByText('qbit_recovery_removal_unverified')).toBeTruthy());
    expect(screen.getByText('qbit_recovery_removal_destination')).toBeTruthy();
  });

  it('cancels the risk step without sending anything more', async () => {
    harness.resetWallet.mockRejectedValueOnce(ackRequired(destinationReasons));
    render(<ResetWalletPopover onClose={onClose} />);
    typePassword(PASSWORD);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByText('reset_wallet_recovery_title')).toBeTruthy());

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'reset_wallet_recovery_title' }), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(harness.resetWallet).toHaveBeenCalledTimes(1);
  });

  it('returns to the password with the message when the acknowledged reset erases nothing', async () => {
    harness.resetWallet
      .mockRejectedValueOnce(ackRequired(destinationReasons))
      .mockRejectedValueOnce({ message: 'wallet is locked' });
    render(<ResetWalletPopover onClose={onClose} />);
    typePassword(PASSWORD);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByText('reset_wallet_recovery_title')).toBeTruthy());
    fireEvent.change(screen.getByTestId('reset-wallet-recovery-confirmation-input'), { target: { value: 'CONFIRM' } });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.getByTestId('reset-wallet-error').textContent).toBe('wallet is locked'));
    expect(screen.queryByText('reset_wallet_recovery_title')).toBeNull();
    expect((screen.getByTestId('reset-wallet-password-input') as HTMLInputElement).value).toBe(PASSWORD);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('tells the user nothing until the background says whether its wallets are still there', async () => {
    const booted = pending<boolean>();
    harness.isBooted.mockReturnValueOnce(booted.promise);
    harness.resetWallet.mockRejectedValueOnce(lostRequest);
    render(<ResetWalletPopover onClose={onClose} />);
    typePassword(PASSWORD);

    fireEvent.click(confirmButton());

    await waitFor(() => expect(harness.isBooted).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('reset-wallet-error')).toBeNull();
    expect(confirmButton().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByTestId('reset-wallet-cancel-button'));
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => booted.resolve(true));
    expect(screen.getByTestId('reset-wallet-error').textContent).toBe(lostRequest.message);
    expect(confirmButton().getAttribute('aria-disabled')).toBe('false');
  });

  it.each([
    ['the question fails too', () => Promise.reject(lostRequest)],
    ['the answer is no boolean', () => Promise.resolve(undefined)]
  ])('shows the message of a lost request, and nothing more, when %s', async (_name, isBooted) => {
    harness.isBooted.mockImplementationOnce(isBooted);
    harness.resetWallet.mockRejectedValueOnce(lostRequest);
    render(<ResetWalletPopover onClose={onClose} />);
    typePassword(PASSWORD);

    fireEvent.click(confirmButton());

    // The message, which says the reset may have run, and no claim either way.
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(lostRequest.message));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('names the last wallet on every attempt, the acknowledged retry included', async () => {
    harness.resetWallet
      .mockRejectedValueOnce(ackRequired(destinationReasons))
      .mockReturnValueOnce(new Promise(() => undefined));
    render(<ResetWalletPopover lastWalletKey="keyring_0" onClose={onClose} />);
    typePassword(PASSWORD);

    fireEvent.click(confirmButton());
    expect(harness.resetWallet).toHaveBeenLastCalledWith(PASSWORD, { lastWalletKey: 'keyring_0' });

    await waitFor(() => expect(screen.getByText('reset_wallet_recovery_title')).toBeTruthy());
    fireEvent.change(screen.getByTestId('reset-wallet-recovery-confirmation-input'), { target: { value: 'CONFIRM' } });
    fireEvent.click(confirmButton());

    expect(harness.resetWallet).toHaveBeenCalledTimes(2);
    expect(harness.resetWallet).toHaveBeenLastCalledWith(PASSWORD, {
      lastWalletKey: 'keyring_0',
      acknowledgedQbitRecoveryRisks: true,
      acknowledgedQbitRecoveryReasons: destinationReasons
    });
  });

  // The background checked, inside the reset, that the wallet is still the
  // last usable one, and found another: it erased nothing.
  it('closes and shows the refusal as an error toast when the wallet is no longer the last', async () => {
    harness.resetWallet.mockRejectedValueOnce({
      code: ErrorCodes.WALLET_RESET_NOT_LAST_WALLET,
      message: 'This is no longer your only usable wallet, so nothing was erased.'
    });
    render(<ResetWalletPopover lastWalletKey="keyring_0" onClose={onClose} />);
    typePassword(PASSWORD);

    fireEvent.click(confirmButton());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(harness.toastError).toHaveBeenCalledWith(
      'This is no longer your only usable wallet, so nothing was erased.'
    );
    expect(screen.queryByTestId('reset-wallet-error')).toBeNull();
    // A refusal from inside the reset needs no question back.
    expect(harness.isBooted).not.toHaveBeenCalled();
    expect(harness.resetWallet).toHaveBeenCalledTimes(1);
  });

  it('falls back to its own text for a refusal without a message', async () => {
    harness.resetWallet.mockRejectedValueOnce({ code: ErrorCodes.WALLET_RESET_NOT_LAST_WALLET });
    render(<ResetWalletPopover lastWalletKey="keyring_0" onClose={onClose} />);
    typePassword(PASSWORD);

    fireEvent.click(confirmButton());

    await waitFor(() => expect(harness.toastError).toHaveBeenCalledWith('wallet_reset_not_last_wallet'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // A last-wallet reset is out when the switcher's list shows another usable
  // wallet: the dialog shows the reset to its end, and the end is never silent.
  it('tells what the background answered when a refused reset ends after its reason went', async () => {
    const answer = pending<void>();
    harness.resetWallet.mockReturnValueOnce(answer.promise);
    const { rerender } = render(<ResetWalletPopover lastWalletKey="keyring_0" onClose={onClose} />);
    typePassword('wrong');
    fireEvent.click(confirmButton());

    // Sent: the dialog shows the reset to its end.
    rerender(<ResetWalletPopover lastWalletKey="keyring_0" outdated onClose={onClose} />);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'reset_wallet' })).toBeTruthy();

    // A wrong password erased nothing: the outdated dialog goes, saying so.
    await act(async () => answer.reject({ message: 'Password is incorrect' }));
    expect(harness.toastError).toHaveBeenCalledTimes(1);
    expect(harness.toastError).toHaveBeenCalledWith('Password is incorrect');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(harness.isBooted).toHaveBeenCalledTimes(1);
  });

  it('explains instead of asking for the risks when -11 arrives after its reason went', async () => {
    const answer = pending<void>();
    harness.resetWallet.mockReturnValueOnce(answer.promise);
    const { rerender } = render(<ResetWalletPopover lastWalletKey="keyring_0" onClose={onClose} />);
    typePassword(PASSWORD);
    fireEvent.click(confirmButton());
    rerender(<ResetWalletPopover lastWalletKey="keyring_0" outdated onClose={onClose} />);

    // The reset can no longer be offered for this wallet: nothing is left to
    // acknowledge, and the dialog says why it goes.
    await act(async () => answer.reject(ackRequired(destinationReasons)));

    expect(harness.toastError).toHaveBeenCalledTimes(1);
    expect(harness.toastError).toHaveBeenCalledWith('wallet_reset_not_last_wallet');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('reset_wallet_recovery_title')).toBeNull();
    expect(harness.resetWallet).toHaveBeenCalledTimes(1);
  });

  it('keeps a refusal inline while its reason holds, and says why when it later goes', async () => {
    harness.resetWallet.mockRejectedValueOnce({ message: 'Password is incorrect' });
    const { rerender } = render(<ResetWalletPopover lastWalletKey="keyring_0" onClose={onClose} />);
    typePassword('wrong');
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Password is incorrect'));
    expect(harness.toastError).not.toHaveBeenCalled();

    rerender(<ResetWalletPopover lastWalletKey="keyring_0" outdated onClose={onClose} />);

    expect(harness.toastError).toHaveBeenCalledWith('wallet_reset_not_last_wallet');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes at once, saying why, when outdated while nothing is out', () => {
    const { rerender } = render(<ResetWalletPopover lastWalletKey="keyring_0" onClose={onClose} />);
    rerender(<ResetWalletPopover lastWalletKey="keyring_0" onClose={onClose} />);
    expect(onClose).not.toHaveBeenCalled();

    rerender(<ResetWalletPopover lastWalletKey="keyring_0" outdated onClose={onClose} />);
    rerender(<ResetWalletPopover lastWalletKey="keyring_0" outdated onClose={onClose} />);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(harness.toastError).toHaveBeenCalledTimes(1);
    expect(harness.toastError).toHaveBeenCalledWith('wallet_reset_not_last_wallet');
    expect(harness.resetWallet).not.toHaveBeenCalled();
  });

  describe('with the page reset handler installed', () => {
    const clearMemory = vi.fn();
    const reload = vi.fn();
    let uninstall: () => void;

    beforeEach(() => {
      clearMemory.mockReset();
      reload.mockReset();
      const listeners = new Set<() => void>();
      uninstall = installWalletResetHandler(createWalletResetHandler({ clearMemory, reload }), {
        addEventListener: (_type, listener) => listeners.add(listener),
        removeEventListener: (_type, listener) => listeners.delete(listener)
      });
    });

    afterEach(() => {
      uninstall();
    });

    it('reopens the window on Welcome once the reset succeeded', async () => {
      harness.resetWallet.mockResolvedValueOnce(undefined);
      render(<ResetWalletPopover onClose={onClose} />);
      typePassword(PASSWORD);

      fireEvent.click(confirmButton());

      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(clearMemory).toHaveBeenCalled();
      expect(harness.toastError).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('shows the incomplete reset as an error toast once the window reopens', async () => {
      harness.resetWallet.mockRejectedValueOnce({
        code: ErrorCodes.WALLET_RESET_INCOMPLETE,
        message: 'wallet_reset_incomplete'
      });
      render(<ResetWalletPopover onClose={onClose} />);
      typePassword(PASSWORD);

      fireEvent.click(confirmButton());

      // The wallets are gone: no message in the dialog, and the window reopens.
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId('reset-wallet-error')).toBeNull();
      expect(sessionStorage.getItem(WALLET_RESET_NOTICE_KEY)).toBe('incomplete');
      expect(onClose).not.toHaveBeenCalled();

      // The reopened page.
      cleanup();
      render(<WalletResetNotice />);
      expect(harness.toastError).toHaveBeenCalledTimes(1);
      expect(harness.toastError).toHaveBeenCalledWith('wallet_reset_incomplete');
      expect(sessionStorage.getItem(WALLET_RESET_NOTICE_KEY)).toBeNull();

      // Once only.
      cleanup();
      render(<WalletResetNotice />);
      expect(harness.toastError).toHaveBeenCalledTimes(1);
    });

    it('does not reopen the window for a refusal that erased nothing', async () => {
      harness.resetWallet.mockRejectedValueOnce({ message: 'Password is incorrect' });
      render(<ResetWalletPopover onClose={onClose} />);
      typePassword('wrong');

      fireEvent.click(confirmButton());

      await waitFor(() => expect(screen.getByTestId('reset-wallet-error')).toBeTruthy());
      expect(reload).not.toHaveBeenCalled();
      expect(clearMemory).not.toHaveBeenCalled();
    });

    // The port closed under the request: the reset may have run, and its
    // WALLET_RESET was lost with the port.
    it('reopens on Welcome when a lost request erased the wallets after all', async () => {
      harness.isBooted.mockResolvedValueOnce(false);
      harness.resetWallet.mockRejectedValueOnce(lostRequest);
      render(<ResetWalletPopover onClose={onClose} />);
      typePassword(PASSWORD);

      fireEvent.click(confirmButton());

      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(clearMemory).toHaveBeenCalled();
      expect(harness.isBooted).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('reset-wallet-error')).toBeNull();
      expect(confirmButton().getAttribute('aria-disabled')).toBe('true');
      expect(onClose).not.toHaveBeenCalled();
    });

    it('keeps the window as it is when a lost request erased nothing', async () => {
      harness.resetWallet.mockRejectedValueOnce(lostRequest);
      render(<ResetWalletPopover onClose={onClose} />);
      typePassword(PASSWORD);

      fireEvent.click(confirmButton());

      await waitFor(() => expect(screen.getByTestId('reset-wallet-error').textContent).toBe(lostRequest.message));
      expect(reload).not.toHaveBeenCalled();
      expect(clearMemory).not.toHaveBeenCalled();
    });

    it('asks nothing back after an incomplete reset, which erased the wallets', async () => {
      harness.resetWallet.mockRejectedValueOnce({ code: ErrorCodes.WALLET_RESET_INCOMPLETE });
      render(<ResetWalletPopover onClose={onClose} />);
      typePassword(PASSWORD);

      fireEvent.click(confirmButton());

      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(harness.isBooted).not.toHaveBeenCalled();
    });
  });
});
