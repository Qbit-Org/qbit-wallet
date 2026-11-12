import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getUiType } from '@/ui/web';
import { cleanup, render, waitFor } from '@testing-library/react';
import { useApproval, useI18n, useTools, useWallet } from '@qbit/wallet-state';

import { useNavigate } from '../MainRoute';
import BoostScreen from './BoostScreen';

vi.mock('@qbit/wallet-state', () => ({
  useApproval: vi.fn(),
  useI18n: vi.fn(),
  useTools: vi.fn(),
  useWallet: vi.fn()
}));

vi.mock('@/ui/web', () => ({
  getUiType: vi.fn()
}));

vi.mock('../MainRoute', () => ({
  useNavigate: vi.fn()
}));

// Every redirect takes the start screen's place in the history.
const REPLACE = { replace: true };

describe('BoostScreen', () => {
  const navigate = vi.fn();
  const wallet = {
    getCurrentAccount: vi.fn(),
    hasVault: vi.fn(),
    isBooted: vi.fn(),
    isReady: vi.fn(),
    isUnlocked: vi.fn(),
    rejectApproval: vi.fn(),
    resolveUnlockApproval: vi.fn(),
    setOpenInSidePanel: vi.fn()
  };
  // The approval screens' context: its rejectApproval would also send the page
  // back to this screen, so this screen reads with it and nothing more.
  const approval = {
    getApproval: vi.fn()
  };
  const tools = { toastWarning: vi.fn() };

  beforeEach(() => {
    vi.mocked(useNavigate).mockReturnValue(navigate);
    vi.mocked(useWallet).mockReturnValue(wallet as unknown as ReturnType<typeof useWallet>);
    vi.mocked(useApproval).mockReturnValue(approval as unknown as ReturnType<typeof useApproval>);
    vi.mocked(useTools).mockReturnValue(tools as unknown as ReturnType<typeof useTools>);
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as unknown as ReturnType<typeof useI18n>);
    vi.mocked(getUiType).mockReturnValue({
      isNotification: false,
      isPop: true,
      isSidePanel: false,
      isTab: false
    });

    wallet.isReady.mockResolvedValue(true);
    wallet.isBooted.mockResolvedValue(true);
    wallet.hasVault.mockResolvedValue(true);
    wallet.isUnlocked.mockResolvedValue(true);
    wallet.getCurrentAccount.mockResolvedValue({ address: 'qbit-test-address' });
    wallet.setOpenInSidePanel.mockResolvedValue(undefined);
    // The background answers the unlock request only while unlocked.
    wallet.resolveUnlockApproval.mockImplementation(async () => wallet.isUnlocked());
    approval.getApproval.mockResolvedValue(undefined);
    wallet.rejectApproval.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it('opens the wallet homepage for an initialized toolbar popup', async () => {
    render(<BoostScreen />);

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('MainScreen', undefined, undefined, REPLACE);
    });

    expect(wallet.getCurrentAccount).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
    expect(wallet.rejectApproval).not.toHaveBeenCalled();
  });

  it('cancels only the approval it read when opened outside an approval window', async () => {
    approval.getApproval.mockResolvedValue({ id: 'read-approval-id', data: { approvalComponent: 'Connect' } });
    render(<BoostScreen />);

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('MainScreen', undefined, undefined, REPLACE);
    });
    expect(wallet.rejectApproval).toHaveBeenCalledOnce();
    expect(wallet.rejectApproval).toHaveBeenCalledWith('read-approval-id');
  });

  it('tells the user when opening the wallet cancelled a website request', async () => {
    approval.getApproval.mockResolvedValue({ id: 'read-approval-id', data: { approvalComponent: 'SignPsbt' } });
    wallet.rejectApproval.mockResolvedValue(true);
    render(<BoostScreen />);

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('MainScreen', undefined, undefined, REPLACE);
    });
    expect(wallet.rejectApproval).toHaveBeenCalledWith('read-approval-id');
    expect(tools.toastWarning).toHaveBeenCalledOnce();
    expect(tools.toastWarning).toHaveBeenCalledWith('request_cancelled_by_opening_wallet');
  });

  it('says nothing when the approval it read was already settled', async () => {
    approval.getApproval.mockResolvedValue({ id: 'read-approval-id', data: { approvalComponent: 'Connect' } });
    wallet.rejectApproval.mockResolvedValue(false);
    render(<BoostScreen />);

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('MainScreen', undefined, undefined, REPLACE);
    });
    expect(wallet.rejectApproval).toHaveBeenCalledWith('read-approval-id');
    expect(tools.toastWarning).not.toHaveBeenCalled();
  });

  it.each([
    ['toolbar popup', { isNotification: false, isPop: true, isSidePanel: false, isTab: false }],
    ['side panel', { isNotification: false, isPop: false, isSidePanel: true, isTab: false }],
    ['wallet tab', { isNotification: false, isPop: false, isSidePanel: false, isTab: true }]
  ])("leaves a website's unlock request pending when the %s opens", async (_label, uiType) => {
    vi.mocked(getUiType).mockReturnValue(uiType);
    wallet.isUnlocked.mockResolvedValue(false);
    approval.getApproval.mockResolvedValue({ id: 'unlock-approval-id', data: { lock: true } });
    wallet.rejectApproval.mockResolvedValue(true);
    render(<BoostScreen />);

    // Unlocking here answers the site's unlock request instead.
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('UnlockScreen', { autoUnlockByFace: true }, undefined, REPLACE);
    });
    expect(wallet.rejectApproval).not.toHaveBeenCalled();
    expect(tools.toastWarning).not.toHaveBeenCalled();
  });

  it.each([
    ['toolbar popup', { isNotification: false, isPop: true, isSidePanel: false, isTab: false }],
    ['side panel', { isNotification: false, isPop: false, isSidePanel: true, isTab: false }],
    ['wallet tab', { isNotification: false, isPop: false, isSidePanel: false, isTab: true }]
  ])("answers a website's unlock request when the %s opens on an unlocked wallet", async (_label, uiType) => {
    vi.mocked(getUiType).mockReturnValue(uiType);
    approval.getApproval.mockResolvedValue({ id: 'unlock-approval-id', data: { lock: true } });
    render(<BoostScreen />);

    // A stale unlock request would otherwise block every later approval.
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('MainScreen', undefined, undefined, REPLACE);
    });
    expect(wallet.resolveUnlockApproval).toHaveBeenCalledOnce();
    await expect(wallet.resolveUnlockApproval.mock.results[0].value).resolves.toBe(true);
    expect(wallet.rejectApproval).not.toHaveBeenCalled();
    expect(tools.toastWarning).not.toHaveBeenCalled();
  });

  it('leaves the pending approval to the approval window that renders it', async () => {
    vi.mocked(getUiType).mockReturnValue({
      isNotification: true,
      isPop: false,
      isSidePanel: false,
      isTab: false
    });
    approval.getApproval.mockResolvedValue({ id: 'read-approval-id', data: { approvalComponent: 'Connect' } });
    render(<BoostScreen />);

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('ApprovalScreen', undefined, undefined, REPLACE);
    });
    expect(wallet.rejectApproval).not.toHaveBeenCalled();
  });

  // Back from the screen it opens must not land here, where it would be sent
  // on again: each redirect replaces this screen's entry, with its state.
  it.each([
    {
      opens: 'Welcome for a wallet never set up',
      arrange: () => wallet.isBooted.mockResolvedValue(false),
      route: 'WelcomeScreen',
      state: undefined
    },
    {
      opens: 'the unlock screen for a locked wallet',
      arrange: () => wallet.isUnlocked.mockResolvedValue(false),
      route: 'UnlockScreen',
      state: { autoUnlockByFace: true }
    },
    {
      opens: 'Welcome for an unlocked wallet without a vault',
      arrange: () => wallet.hasVault.mockResolvedValue(false),
      route: 'WelcomeScreen',
      state: undefined
    },
    {
      opens: 'wallet creation outside the popup, side panel, tab and approval window',
      arrange: () =>
        vi.mocked(getUiType).mockReturnValue({ isNotification: false, isPop: false, isSidePanel: false, isTab: false }),
      route: 'CreateHDWalletScreen',
      state: { isImport: false }
    },
    {
      opens: 'Welcome for a wallet without a current account',
      arrange: () => wallet.getCurrentAccount.mockResolvedValue(undefined),
      route: 'WelcomeScreen',
      state: undefined
    },
    {
      opens: 'the approval in an approval window',
      arrange: () => {
        vi.mocked(getUiType).mockReturnValue({ isNotification: true, isPop: false, isSidePanel: false, isTab: false });
        approval.getApproval.mockResolvedValue({ id: 'read-approval-id', data: { approvalComponent: 'Connect' } });
      },
      route: 'ApprovalScreen',
      state: undefined
    },
    {
      opens: 'Home for an unlocked wallet',
      arrange: () => undefined,
      route: 'MainScreen',
      state: undefined
    }
  ])('opens $opens in place of its own history entry', async ({ arrange, route, state }) => {
    arrange();
    render(<BoostScreen />);

    await waitFor(() => {
      expect(navigate).toHaveBeenCalled();
    });
    expect(navigate.mock.calls).toEqual([[route, state, undefined, REPLACE]]);
  });

  it('redirects nothing once it has gone', async () => {
    let answer!: (unlocked: boolean) => void;
    wallet.isUnlocked.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        })
    );
    const view = render(<BoostScreen />);
    await waitFor(() => expect(wallet.isUnlocked).toHaveBeenCalled());

    // Back, say, took the page elsewhere before the background answered.
    view.unmount();
    answer(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(navigate).not.toHaveBeenCalled();
  });

  it('stops waiting for the background to start once it has gone', async () => {
    vi.useFakeTimers();
    try {
      wallet.isReady.mockResolvedValue(false);
      approval.getApproval.mockResolvedValue({ id: 'read-approval-id', data: { approvalComponent: 'Connect' } });
      const view = render(<BoostScreen />);
      await vi.advanceTimersByTimeAsync(0);
      expect(wallet.isReady).toHaveBeenCalledOnce();

      view.unmount();
      wallet.isReady.mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(5_000);

      // The retry already set asks once more, and nothing follows it.
      expect(wallet.isReady).toHaveBeenCalledTimes(2);
      expect(approval.getApproval).not.toHaveBeenCalled();
      expect(wallet.rejectApproval).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
