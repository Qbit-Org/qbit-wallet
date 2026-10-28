import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalContextType, useApproval, useNavigation, useWallet } from '@qbit/wallet-state';
import { cleanup, render } from '@testing-library/react';

import { ApprovalProvider } from './ApprovalProvider';

vi.mock('@qbit/wallet-state', async () => {
  const React = await import('react');
  const ApprovalContext = React.createContext<unknown>(null);
  return {
    ApprovalContext,
    useApproval: () => React.useContext(ApprovalContext),
    useNavigation: vi.fn(),
    useWallet: vi.fn()
  };
});

const APPROVAL_ID = 'rendered-approval-id';

describe('ApprovalProvider', () => {
  const wallet = { getApproval: vi.fn(), resolveApproval: vi.fn(), rejectApproval: vi.fn() };
  const navigation = { navToRootHome: vi.fn() };
  let approval: ApprovalContextType;

  function Probe() {
    approval = useApproval();
    return null;
  }

  beforeEach(() => {
    vi.mocked(useWallet).mockReturnValue(wallet as unknown as ReturnType<typeof useWallet>);
    vi.mocked(useNavigation).mockReturnValue(navigation as unknown as ReturnType<typeof useNavigation>);
    render(
      <ApprovalProvider>
        <Probe />
      </ApprovalProvider>
    );
  });

  afterEach(() => {
    cleanup();
  });

  it('resolves the rendered approval by its id, without reading the pending approval first', async () => {
    wallet.resolveApproval.mockResolvedValue(true);

    await expect(approval.resolveApproval(APPROVAL_ID, { signed: true }, false, true)).resolves.toBe(true);

    expect(wallet.resolveApproval).toHaveBeenCalledWith(APPROVAL_ID, { signed: true }, true);
    expect(wallet.getApproval).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(navigation.navToRootHome).toHaveBeenCalledOnce());
  });

  it('rejects the rendered approval by its id', async () => {
    wallet.rejectApproval.mockResolvedValue(true);

    await expect(approval.rejectApproval(APPROVAL_ID, 'user_rejected_the_request')).resolves.toBe(true);

    expect(wallet.rejectApproval).toHaveBeenCalledWith(APPROVAL_ID, 'user_rejected_the_request', false, false);
    expect(wallet.getApproval).not.toHaveBeenCalled();
    expect(navigation.navToRootHome).toHaveBeenCalledOnce();
  });

  it('reports a stale id and returns home, where the approval now pending renders', async () => {
    wallet.resolveApproval.mockResolvedValue(false);
    wallet.rejectApproval.mockResolvedValue(false);

    await expect(approval.resolveApproval('replaced-approval-id')).resolves.toBe(false);
    await expect(approval.rejectApproval('replaced-approval-id')).resolves.toBe(false);

    expect(wallet.resolveApproval).toHaveBeenCalledWith('replaced-approval-id', undefined, false);
    expect(wallet.rejectApproval).toHaveBeenCalledWith('replaced-approval-id', undefined, false, false);
    await vi.waitFor(() => expect(navigation.navToRootHome).toHaveBeenCalledTimes(2));
  });

  it('settles nothing for a screen that rendered no approval', async () => {
    await expect(approval.resolveApproval(undefined, { signed: true })).resolves.toBe(false);
    await expect(approval.rejectApproval(undefined)).resolves.toBe(false);

    expect(wallet.resolveApproval).not.toHaveBeenCalled();
    expect(wallet.rejectApproval).not.toHaveBeenCalled();
  });

  it('stays on the screen when asked to', async () => {
    wallet.rejectApproval.mockResolvedValue(true);

    await approval.rejectApproval(APPROVAL_ID, 'decode failed', true);

    expect(wallet.rejectApproval).toHaveBeenCalledWith(APPROVAL_ID, 'decode failed', true, false);
    expect(navigation.navToRootHome).not.toHaveBeenCalled();
  });
});
