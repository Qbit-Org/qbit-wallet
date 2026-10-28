import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useApproval, useWallet } from '@qbit/wallet-state';
import { cleanup, render, waitFor } from '@testing-library/react';

import ApprovalScreen from './ApprovalScreen';
import { Connect } from './components';

const navigate = vi.fn();

vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('@qbit/wallet-state', () => ({ useApproval: vi.fn(), useWallet: vi.fn() }));
// `Missing` stands for an approvalComponent the UI has no screen for.
vi.mock('./components', () => ({ Connect: vi.fn(() => null), Missing: undefined }));

const session = { origin: 'https://dapp.test', icon: '', name: 'Dapp' };
const CONNECT = {
  id: 'connect-approval-id',
  data: { approvalComponent: 'Connect', params: { session }, origin: session.origin }
};

describe('ApprovalScreen', () => {
  const wallet = { getCurrentAccount: vi.fn(), resolveUnlockApproval: vi.fn() };
  const approval = { getApproval: vi.fn(), resolveApproval: vi.fn(), rejectApproval: vi.fn() };

  beforeEach(() => {
    vi.mocked(useWallet).mockReturnValue(wallet as unknown as ReturnType<typeof useWallet>);
    vi.mocked(useApproval).mockReturnValue(approval);
    wallet.getCurrentAccount.mockResolvedValue({ address: 'qbit-address' });
    approval.rejectApproval.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the approval component with the id read together with its data', async () => {
    approval.getApproval.mockResolvedValue(CONNECT);
    render(<ApprovalScreen />);

    await waitFor(() => expect(Connect).toHaveBeenCalled());
    expect(vi.mocked(Connect).mock.calls.at(-1)?.[0]).toEqual({
      approvalId: CONNECT.id,
      params: CONNECT.data.params,
      origin: CONNECT.data.origin,
      requestDefer: undefined
    });
    expect(approval.rejectApproval).not.toHaveBeenCalled();
  });

  it('rejects the approval it read, by its id, when no account is selected', async () => {
    approval.getApproval.mockResolvedValue(CONNECT);
    wallet.getCurrentAccount.mockResolvedValue(null);
    render(<ApprovalScreen />);

    await waitFor(() => expect(approval.rejectApproval).toHaveBeenCalledWith(CONNECT.id));
    expect(Connect).not.toHaveBeenCalled();
  });

  it('rejects an approval it has no component for by its id', async () => {
    approval.getApproval.mockResolvedValue({ id: 'unknown-approval-id', data: { approvalComponent: 'Missing' } });
    render(<ApprovalScreen />);

    await waitFor(() => expect(approval.rejectApproval).toHaveBeenCalledWith('unknown-approval-id'));
    expect(approval.rejectApproval).toHaveBeenCalledOnce();
    expect(Connect).not.toHaveBeenCalled();
  });

  it('answers the unlock request through the unlock-only resolve instead of rejecting it', async () => {
    approval.getApproval.mockResolvedValue({ id: 'unlock-approval-id', data: { lock: true } });
    wallet.resolveUnlockApproval.mockResolvedValue(true);
    render(<ApprovalScreen />);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
    expect(wallet.resolveUnlockApproval).toHaveBeenCalledOnce();
    expect(approval.rejectApproval).not.toHaveBeenCalled();
    expect(approval.resolveApproval).not.toHaveBeenCalled();
  });

  it('leaves the window when no approval is pending', async () => {
    approval.getApproval.mockResolvedValue(undefined);
    render(<ApprovalScreen />);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
    expect(approval.rejectApproval).not.toHaveBeenCalled();
  });
});
