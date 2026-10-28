import type { ChangeEvent, KeyboardEvent, ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getUiType } from '@/ui/web';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  useApproval,
  useBiometricUnlock,
  useI18n,
  useIsUnlocked,
  useNavigation,
  useTools,
  useUnlockCallback,
  useWallet
} from '@qbit/wallet-state';

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

vi.mock('@qbit/wallet-state', () => ({
  BiometricCeremonyCancelledError: class extends Error {},
  BiometricRecordStaleError: class extends Error {},
  useApproval: vi.fn(),
  useBiometricUnlock: vi.fn(),
  useI18n: vi.fn(),
  useIsUnlocked: vi.fn(),
  useNavigation: vi.fn(),
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
});
