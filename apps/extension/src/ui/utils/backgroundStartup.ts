import type { useWallet } from '@qbit/wallet-state';

type WalletController = ReturnType<typeof useWallet>;

export type BackgroundStartupStatus = Awaited<ReturnType<WalletController['getBackgroundStartupStatus']>>;
export type BackgroundStartupFailure = Extract<BackgroundStartupStatus, { state: 'failed' }>;

const FIRST_POLL_DELAY_MS = 50;
// Low, so a cold start renders about as soon as it finishes.
const MAX_POLL_DELAY_MS = 200;

type SettledStartup = Exclude<BackgroundStartupStatus, { state: 'starting' }>;

/** `promise`, or undefined once `ms` have passed without it settling. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
    })
  ]).finally(() => clearTimeout(timer));
}

/**
 * Ask until start-up has finished or failed, waiting between two questions a
 * delay that doubles from 50 ms up to 200 ms; undefined once `deadline` (a
 * Date.now() time) has passed, a question still unanswered included.
 */
async function pollStartup(
  wallet: Pick<WalletController, 'getBackgroundStartupStatus'>,
  deadline: number
): Promise<SettledStartup | undefined> {
  for (let delay = FIRST_POLL_DELAY_MS; ; delay = Math.min(delay * 2, MAX_POLL_DELAY_MS)) {
    try {
      const asked = wallet.getBackgroundStartupStatus();
      const status = Number.isFinite(deadline) ? await within(asked, deadline - Date.now()) : await asked;
      if (status?.state === 'ready' || status?.state === 'failed') {
        return status;
      }
    } catch {
      // The background is not listening yet.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return undefined;
    }
    // The last question is asked when the time is up.
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
  }
}

/**
 * Wait until background start-up has finished or failed. While it is still
 * running, or the background does not answer yet, ask again after a delay that
 * doubles from 50 ms up to 200 ms. A failure ends the wait: start-up runs once
 * per worker start, so asking again cannot change the answer.
 */
export async function waitForBackgroundStartup(
  wallet: Pick<WalletController, 'getBackgroundStartupStatus'>
): Promise<SettledStartup> {
  // With no deadline the loop returns only with a settled status.
  return (await pollStartup(wallet, Infinity)) as SettledStartup;
}

/**
 * Whether background start-up finishes within `timeoutMs`, asked as
 * waitForBackgroundStartup asks. False once it failed, and once the time is up
 * while it was still running or did not answer: the wait always ends.
 */
export async function waitForBackgroundReady(
  wallet: Pick<WalletController, 'getBackgroundStartupStatus'>,
  timeoutMs: number
): Promise<boolean> {
  return (await pollStartup(wallet, Date.now() + timeoutMs))?.state === 'ready';
}
