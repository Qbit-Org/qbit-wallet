import { getUiType } from '@/ui/web';
import type { useWallet } from '@qbit/wallet-state';

import { noteWalletActivity } from './walletActivity';

type WalletController = ReturnType<typeof useWallet>;

/**
 * Opening the popup or the side panel is a screen action, as a key press there
 * is: noteWalletActivity sends it, and says what the background does with it
 * and how a failure is dropped.
 *
 * Only the user opens those two pages. The others can load without the user:
 * an approval window (notification.html) for a site's request, and the wallet
 * tab (index.html) for a site that navigates to a flagged host. Counting their
 * loads would let any site keep the wallet unlocked, so in them only keys and
 * the mouse count. The page decides by its path, since every page connects to
 * the background under the same port name.
 *
 * Call it once per page load, once the background is ready. It returns at
 * once: nothing waits for the background's answer.
 */
export function noteWalletOpened(wallet: Pick<WalletController, 'setLastActiveTime'>): void {
  const { isPop, isSidePanel } = getUiType();
  if (!isPop && !isSidePanel) return;
  noteWalletActivity(wallet);
}
