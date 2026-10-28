import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { PendingApproval, useApproval, useWallet } from '@qbit/wallet-state';

import * as ApprovalComponent from './components';

export default function ApprovalScreen() {
  const wallet = useWallet();
  const { getApproval, rejectApproval } = useApproval();

  const [approval, setApproval] = useState<PendingApproval | null>(null);

  const navigate = useNavigate();

  const init = async () => {
    const approval = await getApproval();
    if (!approval) {
      navigate('/');
      return null;
    }
    if (approval.data.lock === true) {
      // The provider's unlock request has no screen: the unlock answers it,
      // and the background resolves it only while the wallet is unlocked.
      await wallet.resolveUnlockApproval().catch(() => false);
      navigate('/');
      return null;
    }
    if (!ApprovalComponent[approval.data.approvalComponent]) {
      rejectApproval(approval.id);
      return null;
    }
    const account = await wallet.getCurrentAccount();
    if (!account) {
      rejectApproval(approval.id);
      return;
    }
    setApproval(approval);
    const { data } = approval;
    if (data.origin || data.params?.origin) {
      document.title = data.origin || data.params.origin;
    }
  };

  useEffect(() => {
    init();
  }, []);

  if (!approval) return <></>;
  const { approvalComponent, params, origin, requestDefer } = approval.data;
  const CurrentApprovalComponent = ApprovalComponent[approvalComponent];
  // The component settles this approval only, by the id read with its data.
  return (
    <CurrentApprovalComponent
      approvalId={approval.id}
      params={params}
      origin={origin}
      requestDefer={requestDefer}
    />
  );
}
