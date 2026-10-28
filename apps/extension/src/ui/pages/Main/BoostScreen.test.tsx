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

describe('BoostScreen', () => {
  const navigate = vi.fn();
  const wallet = {
    getCurrentAccount: vi.fn(),
    hasVault: vi.fn(),
    isBooted: vi.fn(),
    isReady: vi.fn(),
    isUnlocked: vi.fn(),
    setOpenInSidePanel: vi.fn()
  };
  const approval = {
    getApproval: vi.fn(),
    rejectApproval: vi.fn()
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
    approval.getApproval.mockResolvedValue(undefined);
    approval.rejectApproval.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it('opens the wallet homepage for an initialized toolbar popup', async () => {
    render(<BoostScreen />);

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('MainScreen');
    });

    expect(wallet.getCurrentAccount).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalledWith('CreateHDWalletScreen', { isImport: false });
    expect(approval.rejectApproval).not.toHaveBeenCalled();
  });

  it('cancels only the approval it read when opened outside an approval window', async () => {
    approval.getApproval.mockResolvedValue({ id: 'read-approval-id', data: { approvalComponent: 'Connect' } });
    render(<BoostScreen />);

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('MainScreen');
    });
    expect(approval.rejectApproval).toHaveBeenCalledOnce();
    expect(approval.rejectApproval).toHaveBeenCalledWith('read-approval-id');
  });

  it('tells the user when opening the wallet cancelled a website request', async () => {
    approval.getApproval.mockResolvedValue({ id: 'read-approval-id', data: { approvalComponent: 'SignPsbt' } });
    approval.rejectApproval.mockResolvedValue(true);
    render(<BoostScreen />);

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('MainScreen');
    });
    expect(approval.rejectApproval).toHaveBeenCalledWith('read-approval-id');
    expect(tools.toastWarning).toHaveBeenCalledOnce();
    expect(tools.toastWarning).toHaveBeenCalledWith('request_cancelled_by_opening_wallet');
  });

  it('says nothing when the approval it read was already settled', async () => {
    approval.getApproval.mockResolvedValue({ id: 'read-approval-id', data: { approvalComponent: 'Connect' } });
    approval.rejectApproval.mockResolvedValue(false);
    render(<BoostScreen />);

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('MainScreen');
    });
    expect(approval.rejectApproval).toHaveBeenCalledWith('read-approval-id');
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
    approval.rejectApproval.mockResolvedValue(true);
    render(<BoostScreen />);

    // Unlocking here answers the site's unlock request instead.
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('UnlockScreen', { autoUnlockByFace: true });
    });
    expect(approval.rejectApproval).not.toHaveBeenCalled();
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
      expect(navigate).toHaveBeenCalledWith('ApprovalScreen');
    });
    expect(approval.rejectApproval).not.toHaveBeenCalled();
  });
});
