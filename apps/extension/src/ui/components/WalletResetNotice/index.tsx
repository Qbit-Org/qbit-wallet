import { useEffect } from 'react';

import { takeWalletResetNotice } from '@/ui/utils/walletReset';
import { useI18n, useTools } from '@qbit/wallet-state';

/**
 * After a reset this window asked for erased the wallets but could not clear
 * everything (WALLET_RESET_INCOMPLETE), the window reopens on the Welcome
 * screen and says so here, once.
 */
export function WalletResetNotice() {
  const tools = useTools();
  const { t } = useI18n();
  // Taking the notice clears it, so a later run shows nothing again.
  useEffect(() => {
    if (takeWalletResetNotice()) {
      tools.toastError(t('wallet_reset_incomplete'));
    }
  }, [tools, t]);
  return null;
}
