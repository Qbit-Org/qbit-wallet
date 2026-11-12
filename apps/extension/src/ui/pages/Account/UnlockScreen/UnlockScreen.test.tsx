import type { ChangeEvent, KeyboardEvent, ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getUiType } from '@/ui/web';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  BiometricCeremonyCancelledError,
  useApproval,
  useBiometricUnlock,
  useI18n,
  useIsUnlocked,
  useNavigation,
  useTools,
  useUnlockCallback,
  useWallet
} from '@qbit/wallet-state';

import { ErrorCodes } from '@qbit/wallet-shared';
import { ChainType } from '@qbit/wallet-types';
import {
  forgetInterruptedSendForm,
  getInterruptedSendForm,
  noteRedirectToUnlock,
  SEND_FORM_RETURN_FALLBACK_MS
} from '@/ui/utils/sendFormReturn';
import { useNavigate } from '../../MainRoute';
import UnlockScreen from './index';

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children);
  return { Column: Container, Content: Container, Layout: Container, Row: Container };
});

vi.mock('@/ui/components/Button', async () => {
  const React = await import('react');
  return {
    Button: ({
      text,
      onClick,
      disabled,
      'data-testid': testId
    }: {
      text?: string;
      onClick?: () => void;
      disabled?: boolean;
      'data-testid'?: string;
    }) => React.createElement('button', { onClick, disabled, 'data-testid': testId }, text)
  };
});

vi.mock('@/ui/components/Input', async () => {
  const React = await import('react');
  return {
    Input: ({
      onChange,
      onKeyUp,
      'data-testid': testId
    }: {
      onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
      onKeyUp?: (e: KeyboardEvent<HTMLInputElement>) => void;
      'data-testid'?: string;
    }) => React.createElement('input', { onChange, onKeyUp, 'data-testid': testId })
  };
});

vi.mock('@/ui/components/Logo', () => ({ Logo: () => null }));

vi.mock('@/ui/components/Text', () => ({ Text: () => null }));

vi.mock('@/ui/web', () => ({ getUiType: vi.fn() }));

vi.mock('../../MainRoute', () => ({ useNavigate: vi.fn() }));

// The page's store, as the mocked hooks below report it.
vi.mock('react-redux', async () => {
  const walletState = await import('@qbit/wallet-state');
  const store = {
    getState: () => ({ global: { isUnlocked: vi.mocked(walletState.useIsUnlocked)() } }),
    subscribe: () => () => undefined
  };
  return { useStore: () => store };
});

const formResets = vi.hoisted(() => ({ resetFeeRateBar: vi.fn(), resetUiTxCreateScreen: vi.fn() }));

vi.mock('@qbit/wallet-state', () => ({
  BiometricCeremonyCancelledError: class extends Error {},
  BiometricRecordStaleError: class extends Error {},
  useApproval: vi.fn(),
  useBiometricUnlock: vi.fn(),
  useI18n: vi.fn(),
  useIsUnlocked: vi.fn(),
  useNavigation: vi.fn(),
  useResetFeeRateBar: () => formResets.resetFeeRateBar,
  useResetUiTxCreateScreen: () => formResets.resetUiTxCreateScreen,
  useTools: vi.fn(),
  useUnlockCallback: vi.fn(),
  useWallet: vi.fn()
}));

const CONNECT_APPROVAL = { id: 'connect-approval-id', data: { approvalComponent: 'Connect', params: {} } };

describe('UnlockScreen after the wallet unlocks', () => {
  const navigate = vi.fn();
  const navToRootHome = vi.fn();
  const getApproval = vi.fn();
  const unlock = vi.fn();
  let isUnlocked = false;

  function setUi(isNotification: boolean) {
    vi.mocked(getUiType).mockReturnValue({
      isNotification,
      isPop: !isNotification,
      isSidePanel: false,
      isTab: false
    } as ReturnType<typeof getUiType>);
  }

  function renderScreen() {
    return render(
      <MemoryRouter>
        <UnlockScreen />
      </MemoryRouter>
    );
  }

  async function unlockElsewhere(view: ReturnType<typeof renderScreen>) {
    isUnlocked = true;
    await act(async () => {
      view.rerender(
        <MemoryRouter>
          <UnlockScreen />
        </MemoryRouter>
      );
    });
  }

  beforeEach(() => {
    isUnlocked = false;
    setUi(true);
    vi.mocked(useNavigate).mockReturnValue(navigate);
    vi.mocked(useNavigation).mockReturnValue({ navToRootHome } as unknown as ReturnType<typeof useNavigation>);
    vi.mocked(useIsUnlocked).mockImplementation(() => isUnlocked);
    vi.mocked(useApproval).mockReturnValue({
      getApproval,
      resolveApproval: vi.fn(),
      rejectApproval: vi.fn()
    });
    vi.mocked(useUnlockCallback).mockReturnValue(unlock);
    vi.mocked(useBiometricUnlock).mockReturnValue({
      ready: false,
      supported: false,
      enrolled: false,
      unlockWithBiometric: vi.fn()
    } as unknown as ReturnType<typeof useBiometricUnlock>);
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as unknown as ReturnType<typeof useI18n>);
    vi.mocked(useTools).mockReturnValue({ toastError: vi.fn() } as unknown as ReturnType<typeof useTools>);
    vi.mocked(useWallet).mockReturnValue({
      hasVault: vi.fn().mockResolvedValue(true)
    } as unknown as ReturnType<typeof useWallet>);
    getApproval.mockResolvedValue(CONNECT_APPROVAL);
    unlock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it('returns an approval window to root instead of MainScreen when another window unlocks', async () => {
    const view = renderScreen();

    await unlockElsewhere(view);

    expect(navToRootHome).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('leaves an unlock request to the window that unlocked', async () => {
    getApproval.mockResolvedValue({ id: 'unlock-approval-id', data: { lock: true } });
    const view = renderScreen();

    await unlockElsewhere(view);

    expect(getApproval).toHaveBeenCalled();
    expect(navToRootHome).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('routes its own unlock in an approval window back to root once', async () => {
    let finishUnlock!: () => void;
    unlock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishUnlock = resolve;
        })
    );
    const view = renderScreen();

    fireEvent.change(screen.getByTestId('unlock-password-input'), { target: { value: 'password' } });
    fireEvent.click(screen.getByTestId('unlock-button'));
    // The UNLOCKED broadcast lands while this screen's unlock is in flight.
    await unlockElsewhere(view);
    await act(async () => {
      finishUnlock();
    });

    expect(unlock).toHaveBeenCalledWith('password');
    expect(getApproval).not.toHaveBeenCalled();
    expect(navToRootHome).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('returns to root once its own unlock fails after another window unlocked', async () => {
    let failUnlock!: (error: Error) => void;
    unlock.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          failUnlock = reject;
        })
    );
    const view = renderScreen();

    fireEvent.change(screen.getByTestId('unlock-password-input'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByTestId('unlock-button'));
    await unlockElsewhere(view);
    expect(navToRootHome).not.toHaveBeenCalled();

    await act(async () => {
      failUnlock(new Error('invalid password'));
    });

    await waitFor(() => expect(navToRootHome).toHaveBeenCalledOnce());
  });

  it('drops a pending redirect once its own unlock starts', async () => {
    let answerApproval!: (approval: unknown) => void;
    getApproval.mockImplementation(
      () =>
        new Promise((resolve) => {
          answerApproval = resolve;
        })
    );
    unlock.mockImplementation(() => new Promise<void>(() => undefined));
    const view = renderScreen();

    await unlockElsewhere(view);
    fireEvent.change(screen.getByTestId('unlock-password-input'), { target: { value: 'password' } });
    fireEvent.click(screen.getByTestId('unlock-button'));
    await act(async () => {
      answerApproval(CONNECT_APPROVAL);
    });

    expect(unlock).toHaveBeenCalledWith('password');
    expect(navToRootHome).not.toHaveBeenCalled();
  });

  it('says the wallet locked, not that the password was wrong, when it locked while unlocking', async () => {
    setUi(false);
    const toastError = vi.fn();
    vi.mocked(useTools).mockReturnValue({ toastError } as unknown as ReturnType<typeof useTools>);
    // Errors reach the page over the port as plain objects.
    unlock.mockRejectedValue({ message: 'The wallet locked while unlocking.', code: ErrorCodes.WALLET_LOCKED_DURING_UNLOCK });
    renderScreen();

    fireEvent.change(screen.getByTestId('unlock-password-input'), { target: { value: 'password' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('unlock-button'));
    });

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('wallet_locked_during_unlock'));
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId('unlock-password-input')).toBeTruthy();
  });

  it('still opens MainScreen outside an approval window', async () => {
    setUi(false);
    const view = renderScreen();

    await unlockElsewhere(view);

    expect(navigate).toHaveBeenCalledWith('MainScreen');
    expect(getApproval).not.toHaveBeenCalled();
  });

  it('keeps an unlock outside an approval window off the root screen', async () => {
    setUi(false);
    renderScreen();

    fireEvent.change(screen.getByTestId('unlock-password-input'), { target: { value: 'password' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('unlock-button'));
    });

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('MainScreen'));
    expect(navToRootHome).not.toHaveBeenCalled();
  });

  describe('with a send form a lock interrupted in this page', () => {
    const ADDRESS = 'qb1zsendformaccount';
    const getCurrentAccount = vi.fn();
    const getChainType = vi.fn();
    const hasVault = vi.fn();

    // Layout's redirect from the send form, outside an approval window.
    function interruptSendForm() {
      setUi(false);
      window.location.hash = '#/wallet/tx/create';
      noteRedirectToUnlock(
        '/wallet/tx/create',
        {
          accounts: { current: { address: ADDRESS } },
          settings: { chainType: ChainType.QBIT_MAINNET }
        } as unknown as Parameters<typeof noteRedirectToUnlock>[1],
        true
      );
      window.location.hash = '#/account/unlock';
    }

    function typePasswordAndUnlock() {
      fireEvent.change(screen.getByTestId('unlock-password-input'), { target: { value: 'password' } });
      fireEvent.click(screen.getByTestId('unlock-button'));
    }

    // This screen's unlock, which turns the store unlocked before it returns.
    async function unlockHere(view: ReturnType<typeof renderScreen>) {
      let finishUnlock!: () => void;
      unlock.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishUnlock = resolve;
          })
      );
      typePasswordAndUnlock();
      await unlockElsewhere(view);
      await act(async () => {
        finishUnlock();
      });
    }

    let hidden = false;

    beforeEach(() => {
      hidden = false;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      getCurrentAccount.mockResolvedValue({ address: ADDRESS });
      getChainType.mockResolvedValue(ChainType.QBIT_MAINNET);
      hasVault.mockResolvedValue(true);
      vi.mocked(useWallet).mockReturnValue({
        hasVault,
        getCurrentAccount,
        getChainType
      } as unknown as ReturnType<typeof useWallet>);
    });

    afterEach(() => {
      delete (document as { hidden?: boolean }).hidden;
      forgetInterruptedSendForm();
    });

    it('returns its own unlock to the send form through one decision', async () => {
      interruptSendForm();
      const view = renderScreen();

      await unlockHere(view);

      await waitFor(() => expect(navigate).toHaveBeenCalledWith('#back'));
      expect(navigate).toHaveBeenCalledOnce();
      expect(getCurrentAccount).toHaveBeenCalledOnce();
      expect(getChainType).toHaveBeenCalledOnce();
      expect(getInterruptedSendForm()).toBeUndefined();
    });

    it('returns an unlock made in another window to the send form', async () => {
      interruptSendForm();
      const view = renderScreen();

      await unlockElsewhere(view);

      await waitFor(() => expect(navigate).toHaveBeenCalledWith('#back'));
      expect(navigate).toHaveBeenCalledOnce();
    });

    it('does not wait for a hidden page to be shown on its own unlock', async () => {
      interruptSendForm();
      hidden = true;
      const view = renderScreen();

      await unlockHere(view);

      await waitFor(() => expect(navigate).toHaveBeenCalledWith('#back'));
    });

    it('waits for a hidden page to be shown when another window unlocks during its Touch ID prompt', async () => {
      interruptSendForm();
      let endPrompt!: (error: Error) => void;
      const unlockWithBiometric = vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            endPrompt = reject;
          })
      );
      vi.mocked(useBiometricUnlock).mockReturnValue({
        ready: true,
        supported: true,
        enrolled: true,
        unlockWithBiometric
      } as unknown as ReturnType<typeof useBiometricUnlock>);
      const view = renderScreen();
      // The prompt opens by itself while the page is shown, and stays open
      // after the page is hidden.
      await waitFor(() => expect(unlockWithBiometric).toHaveBeenCalledOnce());
      hidden = true;

      await unlockElsewhere(view);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(getCurrentAccount).not.toHaveBeenCalled();
      expect(getChainType).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();

      // That window switches the account; then the page is shown.
      getCurrentAccount.mockResolvedValue({ address: 'qb1zanotheraccount' });
      await act(async () => {
        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
      });

      await waitFor(() => expect(navigate).toHaveBeenCalledWith('MainScreen'));
      expect(navigate).toHaveBeenCalledOnce();
      expect(formResets.resetUiTxCreateScreen).toHaveBeenCalledOnce();
      expect(formResets.resetFeeRateBar).toHaveBeenCalledOnce();
      expect(getInterruptedSendForm()).toBeUndefined();

      // The prompt ends later, unanswered: nothing more happens.
      await act(async () => {
        endPrompt(new BiometricCeremonyCancelledError());
      });
      expect(navigate).toHaveBeenCalledOnce();
      expect(getCurrentAccount).toHaveBeenCalledOnce();
    });

    it.each([
      ['a wrong password', new Error('invalid password')],
      [
        'a lock during the unlock',
        { message: 'The wallet locked while unlocking.', code: ErrorCodes.WALLET_LOCKED_DURING_UNLOCK }
      ]
    ])('keeps the send form for the next attempt after %s', async (_reason, failure) => {
      interruptSendForm();
      // Errors reach the page over the port as plain objects.
      unlock.mockRejectedValueOnce(failure);
      const view = renderScreen();

      fireEvent.change(screen.getByTestId('unlock-password-input'), { target: { value: 'password' } });
      await act(async () => {
        fireEvent.click(screen.getByTestId('unlock-button'));
      });
      // The attempt has ended: the button takes the next one.
      await waitFor(() => expect((screen.getByTestId('unlock-button') as HTMLButtonElement).disabled).toBe(false));

      expect(unlock).toHaveBeenCalledOnce();
      expect(navigate).not.toHaveBeenCalled();
      expect(getInterruptedSendForm()).toEqual({ address: ADDRESS, chainType: ChainType.QBIT_MAINNET });

      await unlockHere(view);

      await waitFor(() => expect(navigate).toHaveBeenCalledWith('#back'));
      expect(navigate).toHaveBeenCalledOnce();
    });

    it('goes to the welcome screen without a vault and forgets the send form', async () => {
      interruptSendForm();
      hasVault.mockResolvedValue(false);
      let answerChainType!: (chainType: ChainType) => void;
      getChainType.mockImplementation(
        () =>
          new Promise((resolve) => {
            answerChainType = resolve;
          })
      );
      const view = renderScreen();

      await unlockHere(view);
      await waitFor(() => expect(navigate).toHaveBeenCalledWith('WelcomeScreen'));
      await act(async () => {
        answerChainType(ChainType.QBIT_MAINNET);
      });

      expect(navigate).toHaveBeenCalledOnce();
      expect(getInterruptedSendForm()).toBeUndefined();
    });

    it('returns an approval window to root when another window unlocks, as without one', async () => {
      interruptSendForm();
      setUi(true);
      const view = renderScreen();

      await unlockElsewhere(view);

      expect(navToRootHome).toHaveBeenCalledOnce();
      expect(navigate).not.toHaveBeenCalled();
      expect(getCurrentAccount).not.toHaveBeenCalled();
      expect(getChainType).not.toHaveBeenCalled();
    });

    it('routes its own unlock in an approval window to root, as without one', async () => {
      interruptSendForm();
      setUi(true);
      const view = renderScreen();

      await unlockHere(view);

      await waitFor(() => expect(navToRootHome).toHaveBeenCalledOnce());
      expect(navigate).not.toHaveBeenCalled();
      expect(getCurrentAccount).not.toHaveBeenCalled();
      expect(getChainType).not.toHaveBeenCalled();
    });

    describe('after the step back to the send form', () => {
      // Timers and the reads' promises, as far as `ms` takes them.
      const advance = (ms: number) =>
        act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });

      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('goes Home once, keeping the form, when the step back leaves this screen up', async () => {
        interruptSendForm();
        const view = renderScreen();

        await unlockElsewhere(view);
        await advance(0);
        expect(navigate.mock.calls).toEqual([['#back']]);
        await advance(SEND_FORM_RETURN_FALLBACK_MS - 1);
        expect(navigate.mock.calls).toEqual([['#back']]);
        await advance(1);
        await advance(SEND_FORM_RETURN_FALLBACK_MS * 3);

        expect(navigate.mock.calls).toEqual([['#back'], ['MainScreen']]);
        expect(formResets.resetUiTxCreateScreen).not.toHaveBeenCalled();
        expect(formResets.resetFeeRateBar).not.toHaveBeenCalled();
      });

      it('does not go Home once the step back has left this screen', async () => {
        interruptSendForm();
        const view = renderScreen();

        await unlockElsewhere(view);
        await advance(0);
        expect(navigate.mock.calls).toEqual([['#back']]);
        // The router showed the form: this screen is gone.
        view.unmount();
        await advance(SEND_FORM_RETURN_FALLBACK_MS * 3);

        expect(navigate.mock.calls).toEqual([['#back']]);
      });

      it('stays behind a lock that came before the fallback, and goes Home on the next unlock', async () => {
        interruptSendForm();
        const view = renderScreen();
        await unlockElsewhere(view);
        await advance(0);

        isUnlocked = false;
        await act(async () => {
          view.rerender(
            <MemoryRouter>
              <UnlockScreen />
            </MemoryRouter>
          );
        });
        await advance(SEND_FORM_RETURN_FALLBACK_MS * 2);
        expect(navigate.mock.calls).toEqual([['#back']]);

        await unlockElsewhere(view);
        await advance(0);

        expect(navigate.mock.calls).toEqual([['#back'], ['MainScreen']]);
        expect(getChainType).toHaveBeenCalledOnce();
      });
    });
  });
});
