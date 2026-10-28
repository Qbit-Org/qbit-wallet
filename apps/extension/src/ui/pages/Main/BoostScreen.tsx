import { useEffect } from 'react';

import { getUiType } from '@/ui/web';
import { useApproval, useI18n, useTools, useWallet } from '@qbit/wallet-state';

import { useNavigate } from '../MainRoute';

export default function BoostScreen() {
  const navigate = useNavigate();
  const wallet = useWallet();
  const tools = useTools();
  const { t } = useI18n();

  const { getApproval, rejectApproval } = useApproval();
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
      // Outside an approval window, cancel the website approval read above,
      // and only it: one that replaced it since is left pending, and so is
      // the provider's unlock request, which unlocking here answers.
      if (approval && approval.data?.lock !== true && (await rejectApproval(approval.id))) {
        tools.toastWarning(t('request_cancelled_by_opening_wallet'));
      }
      approval = undefined;
    }

    const isBooted = await wallet.isBooted();
    const hasVault = await wallet.hasVault();
    const isUnlocked = await wallet.isUnlocked();

    if (!isBooted) {
      navigate('WelcomeScreen');
      return;
    }

    if (!isUnlocked) {
      navigate('UnlockScreen', {
        autoUnlockByFace: true
      });
      return;
    }

    if (!hasVault) {
      navigate('WelcomeScreen');
      return;
    }

    if (!isInNotification && !isInTab && !isInSidePanel && !isInPopup) {
      navigate('CreateHDWalletScreen', { isImport: false });
      return;
    }

    const currentAccount = await wallet.getCurrentAccount();

    if (!currentAccount) {
      navigate('WelcomeScreen');
      return;
    } else if (approval) {
      navigate('ApprovalScreen');
    } else {
      navigate('MainScreen');
      return;
    }
  };

  const init = async () => {
    const ready = await wallet.isReady();

    if (ready) {
      loadView();
    } else {
      setTimeout(() => {
        init();
      }, 1000);
    }
  };

  useEffect(() => {
    init();
  }, []);

  return <div></div>;
}
