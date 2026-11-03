import log from 'loglevel';

import { walletController } from '@qbit/wallet-background';

type SystemLockEvent = 'computer-locked' | 'windows-closed';

/**
 * Lock the wallet when the computer locks and when no normal browser window
 * remains; the controller checks each event's Security setting. Call it while
 * the service worker's script first runs, so that either event starts a
 * stopped worker and reaches these listeners. The lock waits for `restored`,
 * the worker's start-up, since the settings and the keyring load there.
 *
 * The wallet's own approval popups are `popup` windows, not `normal` ones,
 * so they do not keep the wallet unlocked. A browser without the idle or the
 * windows API gets no listener for it.
 */
export function initSystemLock(restored: Promise<unknown>) {
  const lock = (event: SystemLockEvent) => {
    restored
      .then(() => walletController.lockOnSystemEvent(event))
      .catch((error) => {
        log.error(`[Background] Lock on ${event} failed`, error);
      });
  };

  const api = typeof chrome === 'undefined' ? undefined : chrome;

  const idle = api?.idle;
  if (typeof idle?.onStateChanged?.addListener === 'function') {
    idle.onStateChanged.addListener((state) => {
      if (state === 'locked') lock('computer-locked');
    });
  }

  const windows = api?.windows;
  if (typeof windows?.onRemoved?.addListener === 'function' && typeof windows.getAll === 'function') {
    windows.onRemoved.addListener(() => {
      // The callback form works in MV2 and MV3 builds alike. Windows that
      // cannot be listed count as none.
      windows.getAll({ windowTypes: ['normal'] }, (remaining) => {
        const error = api?.runtime?.lastError;
        if (error) {
          log.error('[Background] Could not list the browser windows; locking', error.message);
        }
        if (error || !remaining?.length) lock('windows-closed');
      });
    });
  }
}
