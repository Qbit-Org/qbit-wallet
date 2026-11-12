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
import { unhandledRejectionsDuring } from '../../../../../../../tests/support/unhandledRejections';
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

// The store's record of the account and network the send form belongs to:
// one object, as the page's store keeps it until it clears the form.
const SEND_FORM_SCOPE = vi.hoisted(() => ({ address: 'qb1zsendformaccount', chainType: 'QBIT_MAINNET' }));

// The page's store, as the mocked hooks below report it.
vi.mock('react-redux', async () => {
  const walletState = await import('@qbit/wallet-state');
  const store = {
    getState: () => ({
      global: { isUnlocked: vi.mocked(walletState.useIsUnlocked)() },
      ui: { sendFormScope: SEND_FORM_SCOPE }
    }),
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
// Outside an approval window, where an unlock leads takes the unlock screen's
// history entry.
const REPLACE = { replace: true };

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

  /** A lock reaching the page: the auto-lock, or another window. */
  async function lockElsewhere(view: ReturnType<typeof renderScreen>) {
    isUnlocked = false;
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

  it('reads no vault in an approval window when another window unlocks', async () => {
    const hasVault = vi.fn().mockResolvedValue(false);
    vi.mocked(useWallet).mockReturnValue({ hasVault } as unknown as ReturnType<typeof useWallet>);
    const view = renderScreen();

    await unlockElsewhere(view);

    expect(navToRootHome).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    expect(hasVault).not.toHaveBeenCalled();
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
    unlock.mockRejectedValue({
      message: 'The wallet locked while unlocking.',
      code: ErrorCodes.WALLET_LOCKED_DURING_UNLOCK
    });
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

    expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
    expect(getApproval).not.toHaveBeenCalled();
  });

  it('keeps an unlock outside an approval window off the root screen', async () => {
    setUi(false);
    renderScreen();

    fireEvent.change(screen.getByTestId('unlock-password-input'), { target: { value: 'password' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('unlock-button'));
    });

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('MainScreen', undefined, undefined, REPLACE));
    expect(navToRootHome).not.toHaveBeenCalled();
  });

  describe('outside an approval window', () => {
    const unlockWithBiometric = vi.fn();

    function deferred<T = void>() {
      let resolve!: (value: T) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    function unlockButton() {
      return screen.getByTestId('unlock-button') as HTMLButtonElement;
    }

    function touchIdButton() {
      return screen.getByTestId('unlock-touch-id-button') as HTMLButtonElement;
    }

    function submitPassword() {
      fireEvent.change(screen.getByTestId('unlock-password-input'), { target: { value: 'password' } });
      fireEvent.click(unlockButton());
    }

    beforeEach(() => {
      setUi(false);
      // clearMocks clears calls only: a test's fake answers must not reach the next.
      unlockWithBiometric.mockReset();
      vi.mocked(useBiometricUnlock).mockReturnValue({
        ready: false,
        supported: true,
        enrolled: true,
        unlockWithBiometric
      } as unknown as ReturnType<typeof useBiometricUnlock>);
    });

    it('replaces itself with Home, once, as the store turns unlocked during its own password unlock', async () => {
      const unlocking = deferred();
      unlock.mockReturnValue(unlocking.promise);
      const view = renderScreen();

      submitPassword();
      // The page's store turns unlocked before the unlock call returns: Home
      // takes this screen's place then, without waiting for the attempt.
      await unlockElsewhere(view);
      expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
      await act(async () => {
        unlocking.resolve();
      });

      await waitFor(() => expect(unlockButton().disabled).toBe(false));
      expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
    });

    it('replaces itself with Home, once, as the store turns unlocked during its own Touch ID unlock', async () => {
      const unlocking = deferred();
      unlockWithBiometric.mockReturnValue(unlocking.promise);
      const view = renderScreen();

      fireEvent.click(touchIdButton());
      await unlockElsewhere(view);
      expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
      await act(async () => {
        unlocking.resolve();
      });

      await waitFor(() => expect(touchIdButton().disabled).toBe(false));
      expect(unlockWithBiometric).toHaveBeenCalledOnce();
      expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
    });

    it('replaces itself with Home, once, when its own unlock routes before the store turns unlocked', async () => {
      const view = renderScreen();

      submitPassword();
      await waitFor(() => expect(unlockButton().disabled).toBe(false));
      expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
      await unlockElsewhere(view);

      expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
    });

    it('goes Home at once when another window unlocks while its Touch ID prompt is open, and once only', async () => {
      const prompt = deferred();
      unlockWithBiometric.mockReturnValue(prompt.promise);
      vi.mocked(useBiometricUnlock).mockReturnValue({
        ready: true,
        supported: true,
        enrolled: true,
        unlockWithBiometric
      } as unknown as ReturnType<typeof useBiometricUnlock>);
      const view = renderScreen();
      // The prompt opens by itself.
      await waitFor(() => expect(unlockWithBiometric).toHaveBeenCalledOnce());

      await unlockElsewhere(view);
      expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);

      // The prompt is answered later: that unlock routes nothing more.
      await act(async () => {
        prompt.resolve();
      });
      await waitFor(() => expect(touchIdButton().disabled).toBe(false));
      expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
    });

    it('goes Home at once when another window unlocks during its own attempt, and keeps that attempt’s error', async () => {
      const toastError = vi.fn();
      vi.mocked(useTools).mockReturnValue({ toastError } as unknown as ReturnType<typeof useTools>);
      const unlocking = deferred();
      unlock.mockReturnValue(unlocking.promise);
      const view = renderScreen();

      submitPassword();
      await unlockElsewhere(view);
      expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
      await act(async () => {
        unlocking.reject(new Error('invalid password'));
      });

      await waitFor(() => expect(unlockButton().disabled).toBe(false));
      expect(toastError).toHaveBeenCalledWith('password_error');
      expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
    });

    it.each([
      ['password', 'before', () => submitPassword(), () => unlockButton()],
      ['password', 'after', () => submitPassword(), () => unlockButton()],
      ['Touch ID', 'before', () => fireEvent.click(touchIdButton()), () => touchIdButton()],
      ['Touch ID', 'after', () => fireEvent.click(touchIdButton()), () => touchIdButton()]
    ])(
      'puts Welcome, once, in the place of the Home it gave way to when its own %s unlock finds no vault, the answer landing %s the unlock returns',
      async (_label, answerLands, startUnlock, attemptButton) => {
        const vault = deferred<boolean>();
        const hasVault = vi.fn(() => vault.promise);
        vi.mocked(useWallet).mockReturnValue({ hasVault } as unknown as ReturnType<typeof useWallet>);
        const unlocking = deferred();
        unlock.mockReturnValue(unlocking.promise);
        unlockWithBiometric.mockReturnValue(unlocking.promise);
        const view = renderScreen();

        startUnlock();
        await unlockElsewhere(view);
        expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
        if (answerLands === 'before') {
          await act(async () => {
            vault.resolve(false);
          });
        }
        await act(async () => {
          unlocking.resolve();
        });
        if (answerLands === 'after') {
          await act(async () => {
            vault.resolve(false);
          });
        }

        await waitFor(() => expect(attemptButton().disabled).toBe(false));
        expect(navigate.mock.calls).toEqual([
          ['MainScreen', undefined, undefined, REPLACE],
          ['WelcomeScreen', undefined, undefined, REPLACE]
        ]);
        // Both routes saw this one unlock: one read.
        expect(hasVault).toHaveBeenCalledOnce();
      }
    );

    it('never puts Home over Welcome when the store turns unlocked after its own unlock found no vault', async () => {
      const hasVault = vi.fn().mockResolvedValue(false);
      vi.mocked(useWallet).mockReturnValue({ hasVault } as unknown as ReturnType<typeof useWallet>);
      const view = renderScreen();

      submitPassword();
      await waitFor(() => expect(unlockButton().disabled).toBe(false));
      expect(navigate.mock.calls).toEqual([['WelcomeScreen', undefined, undefined, REPLACE]]);
      await unlockElsewhere(view);

      expect(navigate.mock.calls).toEqual([['WelcomeScreen', undefined, undefined, REPLACE]]);
      expect(hasVault).toHaveBeenCalledOnce();
    });

    it.each([
      ['as the store turns unlocked during it', true],
      ['when it routes before the store turns unlocked', false]
    ])('reads whether there is a vault once for its own unlock, %s', async (_label, storeFirst) => {
      const hasVault = vi.fn().mockResolvedValue(true);
      vi.mocked(useWallet).mockReturnValue({ hasVault } as unknown as ReturnType<typeof useWallet>);
      const unlocking = deferred();
      unlock.mockReturnValue(unlocking.promise);
      const view = renderScreen();

      submitPassword();
      if (storeFirst) {
        await unlockElsewhere(view);
      }
      await act(async () => {
        unlocking.resolve();
      });
      await waitFor(() => expect(unlockButton().disabled).toBe(false));
      if (!storeFirst) {
        await unlockElsewhere(view);
      }

      expect(hasVault).toHaveBeenCalledOnce();
      expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
    });

    describe('when only the store shows the unlock', () => {
      // Another window's unlock while this screen is up, or this screen shown
      // on an unlocked wallet (Back, Forward, a restored tab): no unlock of
      // this screen's own plays a part.
      const unlockSeenByTheStore: [string, () => Promise<unknown>][] = [
        ['another window unlocks', () => unlockElsewhere(renderScreen())],
        [
          'it is shown on an unlocked wallet',
          async () => {
            isUnlocked = true;
            await act(async () => {
              renderScreen();
            });
          }
        ]
      ];

      function walletWith(hasVault: () => Promise<boolean>) {
        vi.mocked(useWallet).mockReturnValue({ hasVault } as unknown as ReturnType<typeof useWallet>);
      }

      it.each(unlockSeenByTheStore)(
        'puts Welcome, once, in the place of the Home it gave way to when %s without a vault',
        async (_label, seeUnlock) => {
          const vault = deferred<boolean>();
          const hasVault = vi.fn(() => vault.promise);
          walletWith(hasVault);

          await seeUnlock();
          // Home does not wait for the read.
          expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
          await act(async () => {
            vault.resolve(false);
          });

          expect(navigate.mock.calls).toEqual([
            ['MainScreen', undefined, undefined, REPLACE],
            ['WelcomeScreen', undefined, undefined, REPLACE]
          ]);
          expect(hasVault).toHaveBeenCalledOnce();
        }
      );

      it.each(unlockSeenByTheStore)('only goes Home when %s with a vault', async (_label, seeUnlock) => {
        const hasVault = vi.fn().mockResolvedValue(true);
        walletWith(hasVault);

        await seeUnlock();
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
        expect(hasVault).toHaveBeenCalledOnce();
      });

      it.each(unlockSeenByTheStore)(
        'stays Home, with nothing unhandled, when the vault read fails after %s',
        async (_label, seeUnlock) => {
          const toastError = vi.fn();
          vi.mocked(useTools).mockReturnValue({ toastError } as unknown as ReturnType<typeof useTools>);
          // A plain function: a spy would handle the rejection it returns.
          // Over the port, a rejection is a plain object.
          const reads = vi.fn();
          walletWith(() => {
            reads();
            return Promise.reject({ message: 'Disconnected', stack: 'Error: Disconnected' });
          });

          const unhandled = await unhandledRejectionsDuring(seeUnlock);

          expect(unhandled).toEqual([]);
          expect(reads).toHaveBeenCalledOnce();
          expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
          expect(toastError).not.toHaveBeenCalled();
        }
      );

      it('stays Home, with nothing unhandled, when the port refuses the vault read outright', async () => {
        // As the port does with every request id in use.
        walletWith(() => {
          throw { message: 'Request limit exceeded', code: -32005 };
        });

        const unhandled = await unhandledRejectionsDuring(() => unlockElsewhere(renderScreen()));

        expect(unhandled).toEqual([]);
        expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
        expect(unlockButton()).toBeTruthy();
      });

      it.each(unlockSeenByTheStore)(
        'stays Home when the vault read never answers after %s',
        async (_label, seeUnlock) => {
          const toastError = vi.fn();
          vi.mocked(useTools).mockReturnValue({ toastError } as unknown as ReturnType<typeof useTools>);
          walletWith(() => new Promise<boolean>(() => undefined));

          await seeUnlock();
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
          });

          expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
          expect(toastError).not.toHaveBeenCalled();
        }
      );

      it('routes nothing on a vault answer that lands after the wallet locked again', async () => {
        const vault = deferred<boolean>();
        walletWith(() => vault.promise);
        const view = renderScreen();
        await unlockElsewhere(view);

        await lockElsewhere(view);
        await act(async () => {
          vault.resolve(false);
        });

        expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
      });

      it('routes nothing on a vault answer for an unlock a newer one has followed, and acts on the newer one’s', async () => {
        const first = deferred<boolean>();
        const second = deferred<boolean>();
        const hasVault = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        walletWith(hasVault);
        const view = renderScreen();
        await unlockElsewhere(view);
        await lockElsewhere(view);
        await unlockElsewhere(view);
        expect(hasVault).toHaveBeenCalledTimes(2);

        await act(async () => {
          first.resolve(false);
        });
        expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);

        await act(async () => {
          second.resolve(false);
        });
        expect(navigate.mock.calls).toEqual([
          ['MainScreen', undefined, undefined, REPLACE],
          ['WelcomeScreen', undefined, undefined, REPLACE]
        ]);
      });
    });

    it('replaces itself with Home, once, when it is shown on an unlocked wallet', async () => {
      // Reached by Back or Forward, or kept by a restored tab.
      isUnlocked = true;
      renderScreen();

      await waitFor(() => expect(navigate).toHaveBeenCalled());
      expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
    });

    it('does not route again for an unlock of its own after it gave way to Home', async () => {
      const view = renderScreen();
      await unlockElsewhere(view);
      expect(navigate).toHaveBeenCalledOnce();

      // Still on screen for a moment: a tap, or the Touch ID prompt, lands.
      submitPassword();

      await waitFor(() => expect(unlockButton().disabled).toBe(false));
      expect(unlock).toHaveBeenCalledOnce();
      expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
    });

    // The password, or the Touch ID, was right and the wallet is unlocked.
    it.each([
      ['password', () => submitPassword(), () => unlockButton()],
      ['Touch ID', () => fireEvent.click(touchIdButton()), () => touchIdButton()]
    ])(
      'ends on Home, once, when routing after its own %s unlock fails, with no unlock error',
      async (_label, startUnlock, attemptButton) => {
        const toastError = vi.fn();
        vi.mocked(useTools).mockReturnValue({ toastError } as unknown as ReturnType<typeof useTools>);
        const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
          // The port to the background dropped right after the unlock.
          const hasVault = deferred<boolean>();
          vi.mocked(useWallet).mockReturnValue({
            hasVault: vi.fn(() => hasVault.promise)
          } as unknown as ReturnType<typeof useWallet>);
          const unlocking = deferred();
          unlock.mockReturnValue(unlocking.promise);
          unlockWithBiometric.mockReturnValue(unlocking.promise);
          const view = renderScreen();

          startUnlock();
          await unlockElsewhere(view);
          await act(async () => {
            unlocking.resolve();
          });
          const disconnected = new Error('Disconnected');
          await act(async () => {
            hasVault.reject(disconnected);
          });

          await waitFor(() => expect(attemptButton().disabled).toBe(false));
          expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
          expect(toastError).not.toHaveBeenCalled();
          expect(logged).toHaveBeenCalledWith(disconnected);
        } finally {
          // Restored even when an assertion above fails.
          logged.mockRestore();
        }
      }
    );

    it.each([
      ['a wrong password', new Error('invalid password'), 'password_error'],
      [
        'a lock while unlocking',
        { message: 'The wallet locked while unlocking.', code: ErrorCodes.WALLET_LOCKED_DURING_UNLOCK },
        'wallet_locked_during_unlock'
      ]
    ])('keeps the unlock error for %s', async (_label, error, toast) => {
      const toastError = vi.fn();
      vi.mocked(useTools).mockReturnValue({ toastError } as unknown as ReturnType<typeof useTools>);
      unlock.mockRejectedValue(error);
      renderScreen();

      submitPassword();

      await waitFor(() => expect(toastError).toHaveBeenCalledWith(toast));
      expect(navigate).not.toHaveBeenCalled();
    });

    it('keeps the Touch ID error when the Touch ID unlock itself fails', async () => {
      const toastError = vi.fn();
      vi.mocked(useTools).mockReturnValue({ toastError } as unknown as ReturnType<typeof useTools>);
      unlockWithBiometric.mockRejectedValue(new Error('The authenticator failed'));
      renderScreen();

      fireEvent.click(touchIdButton());

      await waitFor(() => expect(toastError).toHaveBeenCalledWith('The authenticator failed'));
      expect(navigate).not.toHaveBeenCalled();
    });

    it.each([
      ['with a vault', true],
      ['without a vault', false]
    ])('routes nothing for its own unlock that ends after the screen has gone, %s', async (_label, vault) => {
      const hasVault = vi.fn().mockResolvedValue(vault);
      vi.mocked(useWallet).mockReturnValue({ hasVault } as unknown as ReturnType<typeof useWallet>);
      const unlocking = deferred();
      unlock.mockReturnValue(unlocking.promise);
      const view = renderScreen();

      submitPassword();
      // Back left the screen while the unlock was running.
      view.unmount();
      await act(async () => {
        unlocking.resolve();
      });
      await waitFor(() => expect(hasVault).toHaveBeenCalledOnce());
      // The answer lands, and with it anything it would route.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(unlock).toHaveBeenCalledOnce();
      expect(navigate).not.toHaveBeenCalled();
    });
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
          settings: { chainType: ChainType.QBIT_MAINNET },
          ui: { sendFormScope: SEND_FORM_SCOPE }
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

      await waitFor(() => expect(navigate).toHaveBeenCalledWith('MainScreen', undefined, undefined, REPLACE));
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
      expect(getInterruptedSendForm()).toEqual({
        address: ADDRESS,
        chainType: ChainType.QBIT_MAINNET,
        scope: SEND_FORM_SCOPE
      });

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
      await waitFor(() => expect(navigate).toHaveBeenCalledWith('WelcomeScreen', undefined, undefined, REPLACE));
      await act(async () => {
        answerChainType(ChainType.QBIT_MAINNET);
      });

      expect(navigate).toHaveBeenCalledOnce();
      expect(getInterruptedSendForm()).toBeUndefined();
    });

    it('forgets the send form and ends its decision before Welcome takes its place, for another window’s unlock without a vault', async () => {
      interruptSendForm();
      hasVault.mockResolvedValue(false);
      // The account and network are still being read when the answer lands.
      let answerChainType!: (chainType: ChainType) => void;
      getChainType.mockImplementation(
        () =>
          new Promise((resolve) => {
            answerChainType = resolve;
          })
      );
      // The form the page remembered as each route was taken.
      const formWhenRouted: unknown[] = [];
      vi.mocked(useNavigate).mockReturnValue(
        vi.fn((...route: unknown[]) => {
          formWhenRouted.push(getInterruptedSendForm());
          navigate(...route);
        })
      );
      const view = renderScreen();

      await unlockElsewhere(view);
      await act(async () => {
        answerChainType(ChainType.QBIT_MAINNET);
      });

      expect(navigate.mock.calls).toEqual([['WelcomeScreen', undefined, undefined, REPLACE]]);
      expect(formWhenRouted).toEqual([undefined]);
    });

    it('routes nothing, and keeps a send form remembered since, on a vault answer that lands after the screen went another way', async () => {
      interruptSendForm();
      // The account and network are still being read: no route taken yet.
      getChainType.mockReturnValue(new Promise(() => undefined));
      let answerHasVault!: (hasVault: boolean) => void;
      hasVault.mockReturnValue(
        new Promise<boolean>((resolve) => {
          answerHasVault = resolve;
        })
      );
      const view = renderScreen();
      await unlockElsewhere(view);
      expect(navigate).not.toHaveBeenCalled();
      expect(hasVault).toHaveBeenCalledOnce();

      // Back left the screen; a later lock on the send form, met by another
      // unlock screen, remembered the form again.
      view.unmount();
      interruptSendForm();
      await act(async () => {
        answerHasVault(false);
      });

      expect(navigate).not.toHaveBeenCalled();
      expect(getInterruptedSendForm()).toEqual({
        address: ADDRESS,
        chainType: ChainType.QBIT_MAINNET,
        scope: SEND_FORM_SCOPE
      });
    });

    it('goes Home once, through the decision, when the account changed: its own unlock routes nothing more', async () => {
      interruptSendForm();
      getCurrentAccount.mockResolvedValue({ address: 'qb1zanotheraccount' });
      let answerHasVault!: (hasVault: boolean) => void;
      hasVault.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            answerHasVault = resolve;
          })
      );
      const view = renderScreen();

      await unlockHere(view);
      await waitFor(() => expect(navigate).toHaveBeenCalledWith('MainScreen', undefined, undefined, REPLACE));
      await act(async () => {
        answerHasVault(true);
      });
      await waitFor(() => expect((screen.getByTestId('unlock-button') as HTMLButtonElement).disabled).toBe(false));

      expect(navigate.mock.calls).toEqual([['MainScreen', undefined, undefined, REPLACE]]);
      expect(formResets.resetUiTxCreateScreen).toHaveBeenCalledOnce();
    });

    it('puts Welcome in the place of the decision’s Home when the unlocked wallet has no vault', async () => {
      interruptSendForm();
      getCurrentAccount.mockResolvedValue({ address: 'qb1zanotheraccount' });
      let answerHasVault!: (hasVault: boolean) => void;
      hasVault.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            answerHasVault = resolve;
          })
      );
      const view = renderScreen();

      await unlockHere(view);
      await waitFor(() => expect(navigate).toHaveBeenCalledWith('MainScreen', undefined, undefined, REPLACE));
      await act(async () => {
        answerHasVault(false);
      });
      await waitFor(() => expect((screen.getByTestId('unlock-button') as HTMLButtonElement).disabled).toBe(false));

      expect(navigate.mock.calls).toEqual([
        ['MainScreen', undefined, undefined, REPLACE],
        ['WelcomeScreen', undefined, undefined, REPLACE]
      ]);
    });

    it('starts no return to a send form remembered after the screen has gone, for its own unlock that ends then', async () => {
      let finishUnlock!: () => void;
      unlock.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishUnlock = resolve;
          })
      );
      setUi(false);
      const view = renderScreen();
      typePasswordAndUnlock();
      // Back left the screen while the unlock was running; a later lock on the
      // send form, met by another unlock screen, remembered the form again.
      view.unmount();
      interruptSendForm();
      isUnlocked = true;

      await act(async () => {
        finishUnlock();
      });
      await waitFor(() => expect(hasVault).toHaveBeenCalledOnce());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(getCurrentAccount).not.toHaveBeenCalled();
      expect(getChainType).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
      expect(getInterruptedSendForm()).toEqual({
        address: ADDRESS,
        chainType: ChainType.QBIT_MAINNET,
        scope: SEND_FORM_SCOPE
      });
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

        expect(navigate.mock.calls).toEqual([['#back'], ['MainScreen', undefined, undefined, REPLACE]]);
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

        expect(navigate.mock.calls).toEqual([['#back'], ['MainScreen', undefined, undefined, REPLACE]]);
        expect(getChainType).toHaveBeenCalledOnce();
      });

      it('puts Welcome in this screen’s place, and never Home, when the step back left it up and there is no vault', async () => {
        interruptSendForm();
        let answerHasVault!: (hasVault: boolean) => void;
        hasVault.mockImplementation(
          () =>
            new Promise<boolean>((resolve) => {
              answerHasVault = resolve;
            })
        );
        const view = renderScreen();

        await unlockHere(view);
        await advance(0);
        expect(navigate.mock.calls).toEqual([['#back']]);
        await act(async () => {
          answerHasVault(false);
        });
        await advance(SEND_FORM_RETURN_FALLBACK_MS * 3);

        expect(navigate.mock.calls).toEqual([['#back'], ['WelcomeScreen', undefined, undefined, REPLACE]]);
        expect(getInterruptedSendForm()).toBeUndefined();
      });
    });
  });
});
