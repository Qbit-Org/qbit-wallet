import log from 'loglevel';

import { walletController } from '@qbit/wallet-background';

type SystemLockEvent = 'computer-locked' | 'windows-closed';

// Windows that keep the wallet unlocked: browser windows, and installed web
// apps, which may be the only window a dapp user has open. The wallet's own
// approval popups are `popup` windows, so they do not count.
const OPEN_WINDOW_TYPES: chrome.windows.windowTypeEnum[] = ['normal', 'app'];

/**
 * Lock the wallet when the computer locks and when no browser window remains;
 * the controller checks each event's Security setting. Every change of the
 * computer's idle state, waking included, also applies an overdue auto-lock,
 * since the auto-lock timer does not count the time the computer sleeps. Call
 * it while the service worker's script first runs, so that either event
 * starts a stopped worker and reaches these listeners. Each action waits for
 * `restored`, the worker's start-up, since the settings and the keyring load
 * there. A browser without the idle or the windows API gets no listener for
 * it.
 */
export function initSystemLock(restored: Promise<unknown>) {
  const whenStarted = (label: string, action: () => Promise<unknown>) => {
    restored.then(action).catch((error) => {
      log.error(`[Background] ${label} failed`, error);
    });
  };
  const lock = (event: SystemLockEvent) =>
    whenStarted(`Lock on ${event}`, () => walletController.lockOnSystemEvent(event));

  const api = typeof chrome === 'undefined' ? undefined : chrome;

  const idle = api?.idle;
  if (typeof idle?.onStateChanged?.addListener === 'function') {
    idle.onStateChanged.addListener((state) => {
      if (state === 'locked') lock('computer-locked');
      whenStarted('Overdue auto-lock', () => walletController.lockIfAutoLockOverdue());
    });
  }

  const windows = api?.windows;
  if (typeof windows?.onRemoved?.addListener === 'function' && typeof windows.getAll === 'function') {
    windows.onRemoved.addListener(() => {
      // The callback form works in MV2 and MV3 builds alike. Windows that
      // cannot be listed count as none.
      windows.getAll({ windowTypes: OPEN_WINDOW_TYPES }, (remaining) => {
        const error = api?.runtime?.lastError;
        if (error) {
          log.error('[Background] Could not list the browser windows; locking', error.message);
        }
        if (error || !remaining?.length) lock('windows-closed');
      });
    });
  }
}
