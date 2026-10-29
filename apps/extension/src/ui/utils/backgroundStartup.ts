import type { useWallet } from '@qbit/wallet-state';

type WalletController = ReturnType<typeof useWallet>;

export type BackgroundStartupStatus = Awaited<ReturnType<WalletController['getBackgroundStartupStatus']>>;
export type BackgroundStartupFailure = Extract<BackgroundStartupStatus, { state: 'failed' }>;

const FIRST_POLL_DELAY_MS = 50;
// Low, so a cold start renders about as soon as it finishes.
const MAX_POLL_DELAY_MS = 200;

/**
 * Wait until background start-up has finished or failed. While it is still
 * running, or the background does not answer yet, ask again after a delay that
 * doubles from 50 ms up to 200 ms. A failure ends the wait: start-up runs once
 * per worker start, so asking again cannot change the answer.
 */
export async function waitForBackgroundStartup(
  wallet: Pick<WalletController, 'getBackgroundStartupStatus'>
): Promise<Exclude<BackgroundStartupStatus, { state: 'starting' }>> {
  for (let delay = FIRST_POLL_DELAY_MS; ; delay = Math.min(delay * 2, MAX_POLL_DELAY_MS)) {
    try {
      const status = await wallet.getBackgroundStartupStatus();
      if (status?.state === 'ready' || status?.state === 'failed') {
        return status;
      }
    } catch {
      // The background is not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
