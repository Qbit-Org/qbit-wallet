import { describe, expect, it, vi } from 'vitest';

import { enteringUnlockReplaces } from './unlockEntry';

vi.mock('@/ui/pages/MainRoute', () => ({
  routes: {
    MainScreen: { path: '/main' },
    UnlockScreen: { path: '/account/unlock' },
    TxConfirmScreen: { path: '/wallet/tx/confirm' }
  }
}));

/** Whether a step to the unlock screen from `address` replaces its entry. */
function replacesFrom(address: string): boolean {
  window.history.replaceState(null, '', address);
  return enteringUnlockReplaces();
}

describe('entering the unlock screen', () => {
  it.each([
    ['Home in a wallet tab', '/index.html#/main'],
    ['Home in the popup', '/popup.html#/main'],
    ['Home in the side panel', '/sidepanel.html#/main'],
    ['Home with a query', '/popup.html#/main?tab=wallet'],
    ['the unlock screen another route already showed', '/popup.html#/account/unlock'],
    ['the send confirm screen in a wallet tab', '/index.html#/wallet/tx/confirm'],
    ['the send confirm screen in the popup', '/popup.html#/wallet/tx/confirm'],
    ['the send confirm screen in the side panel', '/sidepanel.html#/wallet/tx/confirm']
  ])('takes the place of %s', (_label, address) => {
    expect(replacesFrom(address)).toBe(true);
  });

  it.each([
    ['Settings', '/popup.html#/settings'],
    ['the send form', '/index.html#/wallet/tx/create'],
    ['the send result screen', '/index.html#/wallet/tx/success'],
    ['the send recovery screen', '/index.html#/wallet/tx/fail'],
    ['a screen whose path starts like the confirm screen’s', '/popup.html#/wallet/tx/confirmed'],
    ['a screen whose path starts like Home’s', '/popup.html#/mainx'],
    ['the start screen', '/popup.html#/'],
    ['a page with no route yet', '/popup.html'],
    ['Home in an approval window', '/notification.html#/main'],
    ['the unlock screen in an approval window', '/notification.html#/account/unlock'],
    ['the send confirm screen in an approval window', '/notification.html#/wallet/tx/confirm']
  ])('adds an entry after %s', (_label, address) => {
    expect(replacesFrom(address)).toBe(false);
  });
});
