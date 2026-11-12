import type { useWallet } from '@qbit/wallet-state';

type WalletController = ReturnType<typeof useWallet>;

/**
 * Counts a screen action, such as a key press or a click, for the auto-lock.
 * To the background (its `setLastActiveTime`) a screen action means the user
 * is still there: before the auto-lock deadline the time starts over, past it
 * the wallet locks, and while an overdue auto-lock is held nothing changes.
 *
 * It sends one request and returns at once: nothing waits for it, and a
 * failure (a wallet that is locking, a closed port, a port with every request
 * id in use) is dropped, without a retry and without a log. Nothing in the
 * page depends on the answer, and an action that is not counted can only let
 * the wallet lock at the time it was already set to lock; the next action
 * sends a new request.
 */
export function noteWalletActivity(wallet: Pick<WalletController, 'setLastActiveTime'>): void {
  try {
    // Typed void, but the request is a promise, which rejects with a plain
    // { message, stack } object.
    Promise.resolve(wallet.setLastActiveTime()).catch(() => undefined);
  } catch {
    // The port refused the request before sending it.
  }
}
