import { approvalService } from '@qbit/wallet-background';

import { winMgr } from '../webapi';

export function initWindow() {
  winMgr.event.on('windowRemoved', (winId: number) => {
    approvalService.handleWindowRemoved(winId);
  });

  winMgr.event.on('windowFocusChange', (winId: number) => {
    // todo
  });

  approvalService.platformOpenWindow = async (winProps) => {
    if (approvalService.approvalWindowId) {
      winMgr.remove(approvalService.approvalWindowId);
    }
    const winId = await winMgr.openNotification(winProps);
    // Without an id (0 means none to the service) the window can be neither
    // tracked nor closed; the service rejects its approval instead.
    if (!winId) {
      throw new Error('Approval window has no id');
    }
    return winId;
  };

  approvalService.platformCloseWindow = async (winId) => {
    await winMgr.remove(winId);
  };

  approvalService.platformFocusWindow = async (winId) => {
    await winMgr.focus(winId);
  };
}
