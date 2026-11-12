import { vi } from 'vitest';

import {
  createUnlockGate,
  getShownWalletId,
  installPageWalletResetHandler,
  pageShowsWalletContent
} from '@/ui/utils/walletReset';
import { setupEventBusListeners } from '@/ui/web/ui-messaging';
import { MESSAGE_TYPE } from '@qbit/wallet-shared';
import type { createAppStore } from '@qbit/wallet-state';

type Broadcast = { type: string; method: string; params?: unknown };

/**
 * The page's own checks around a stand-in background, wired as the UI entry
 * wires them (apps/extension/src/ui/index.tsx): the background's broadcasts
 * reach the page through setupEventBusListeners, which holds an UNLOCKED
 * until the unlock gate (createUnlockGate) has compared the id of the wallet
 * set up with the one the page shows, and the page's WALLET_RESET handler is
 * installed, with its reloads recorded rather than made.
 *
 * `afterUnlock` is what the wallet proxy runs before it answers the page's
 * own unlock request. `uninstall` removes the reset handler.
 */
export function installPageChecks(
  store: ReturnType<typeof createAppStore>,
  wallet: { isBooted(): Promise<unknown>; getWalletId(): Promise<unknown> }
) {
  const listeners: Array<(data: Broadcast) => void> = [];
  const channel = {
    listen: (listener: (data: Broadcast) => void) => {
      listeners.push(listener);
    },
    request: () => undefined
  };
  const reload = vi.fn();
  const reloadOnBoot = vi.fn();
  const uninstall = installPageWalletResetHandler(store, { reload, reloadOnBoot });
  const holdsWallet = () => {
    const { global, keyrings } = store.getState();
    return global.isBooted || keyrings.keyrings.length > 0;
  };
  const showsWalletContent = () => pageShowsWalletContent(store.getState());
  const gate = createUnlockGate({
    holdsWallet,
    shownWalletId: getShownWalletId,
    showsWalletContent,
    isStarted: () => store.getState().global.isReady,
    isUnlocked: () => store.getState().global.isUnlocked,
    wallet: { isBooted: () => wallet.isBooted(), getWalletId: () => wallet.getWalletId() },
    onUnknown: () => undefined,
    refusal: () => 'wallet_page_out_of_date'
  });
  setupEventBusListeners(channel as never, { beforeUnlocked: () => gate.beforeUnlockedBroadcast() });
  const broadcast = (method: string, params?: unknown) => {
    for (const listener of listeners) listener({ type: MESSAGE_TYPE.BG_BROADCAST, method, params });
  };
  return { broadcast, afterUnlock: () => gate.afterUnlock(), reload, reloadOnBoot, uninstall };
}
