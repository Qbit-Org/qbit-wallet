import { useEffect, useRef } from 'react';

import { getUiType } from '@/ui/web';
import { useApproval, useI18n, useTools, useWallet } from '@qbit/wallet-state';

import { type RouteTypes, useNavigate } from '../MainRoute';

export default function BoostScreen() {
  const navigate = useNavigate();
  const wallet = useWallet();
  const tools = useTools();
  const { t } = useI18n();
  // Set once this screen has gone. Its background reads can end after that,
  // and a redirect then would replace whatever entry is current.
  const goneRef = useRef(false);

  // This screen only decides where the wallet opens. The screen it opens
  // takes its place in the history, so Back never returns here to be sent
  // on again. Once this screen has gone, it redirects nothing.
  const redirect = (routeKey: RouteTypes, state?: Record<string, unknown>) => {
    if (!goneRef.current) {
      navigate(routeKey, state, undefined, { replace: true });
    }
  };

  const { getApproval } = useApproval();
  const loadView = async () => {
    const UIType = getUiType();
    const isInNotification = UIType.isNotification;
    const isInTab = UIType.isTab;
    const isInSidePanel = UIType.isSidePanel;
    const isInPopup = UIType.isPop;

    if (isInPopup) {
      try {
        await wallet.setOpenInSidePanel(false);
      } catch (error) {
        console.error('Failed to update side panel preference:', error);
      }
    }

    let approval = await getApproval();
    if (isInNotification && !approval) {
      window.close();
      return;
    }

    if (!isInNotification) {
      if (approval?.data?.lock === true) {
        // The provider's unlock request is answered by unlocking, never
        // rejected. If the wallet is already unlocked (an earlier answer
        // failed, or the unlock raced the request), answer it now as the
        // unlock does: the background resolves it only while unlocked, and
        // otherwise unlocking here answers it.
        await wallet.resolveUnlockApproval().catch(() => false);
      } else if (approval && (await wallet.rejectApproval(approval.id))) {
        // Outside an approval window, cancel the website approval read
        // above, and only it: one that replaced it since is left pending.
        // Straight to the background: the approval screens' rejectApproval
        // also returns to this screen, which would add a second entry for it.
        tools.toastWarning(t('request_cancelled_by_opening_wallet'));
      }
      approval = undefined;
    }

    const isBooted = await wallet.isBooted();
    const hasVault = await wallet.hasVault();
    const isUnlocked = await wallet.isUnlocked();

    if (!isBooted) {
      redirect('WelcomeScreen');
      return;
    }

    if (!isUnlocked) {
      redirect('UnlockScreen', {
        autoUnlockByFace: true
      });
      return;
    }

    if (!hasVault) {
      redirect('WelcomeScreen');
      return;
    }

    if (!isInNotification && !isInTab && !isInSidePanel && !isInPopup) {
      redirect('CreateHDWalletScreen', { isImport: false });
      return;
    }

    const currentAccount = await wallet.getCurrentAccount();

    if (!currentAccount) {
      redirect('WelcomeScreen');
      return;
    } else if (approval) {
      redirect('ApprovalScreen');
    } else {
      redirect('MainScreen');
      return;
    }
  };

  const init = async () => {
    const ready = await wallet.isReady();
    if (goneRef.current) {
      return;
    }

    if (ready) {
      loadView();
    } else {
      setTimeout(() => {
        init();
      }, 1000);
    }
  };

  useEffect(() => {
    goneRef.current = false;
    init();
    return () => {
      goneRef.current = true;
    };
  }, []);

  return <div></div>;
}
