import { getUiType } from '@/ui/web';
import type { useWallet } from '@qbit/wallet-state';

type WalletController = ReturnType<typeof useWallet>;

/**
 * Opening the popup or the side panel is a screen action, as a key press there
 * is: before the auto-lock deadline the time starts over, past it the wallet
 * locks, and while an overdue auto-lock is held nothing changes (the
 * background's `setLastActiveTime`).
 *
 * Only the user opens those two pages. The others can load without the user:
 * an approval window (notification.html) for a site's request, and the wallet
 * tab (index.html) for a site that navigates to a flagged host. Counting their
 * loads would let any site keep the wallet unlocked, so in them only keys and
 * the mouse count. The page decides by its path, since every page connects to
 * the background under the same port name.
 *
 * Call it once per page load, once the background is ready. It sends one
 * request and returns at once: nothing waits for it, and a failure (a wallet
 * that is locking, a closed port, a port with every request id in use) is
 * dropped, without a retry.
 */
export function noteWalletOpened(wallet: Pick<WalletController, 'setLastActiveTime'>): void {
  const { isPop, isSidePanel } = getUiType();
  if (!isPop && !isSidePanel) return;
  try {
    // Typed void, but the request is a promise, which rejects with a plain
    // { message, stack } object.
    Promise.resolve(wallet.setLastActiveTime()).catch(() => undefined);
  } catch {
    // The port refused the request before sending it.
  }
}
