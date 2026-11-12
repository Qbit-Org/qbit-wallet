import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetInterruptedSendForm, getInterruptedSendForm } from '@/ui/utils/sendFormReturn';
import { cleanup, render } from '@testing-library/react';
import { useBooted, useIsUnlocked } from '@qbit/wallet-state';
import { ChainType } from '@qbit/wallet-types';

import { Layout } from './index';

vi.mock('@/ui/pages/MainRoute', () => ({
  routes: {
    UnlockScreen: { path: '/account/unlock' },
    TxCreateScreen: { path: '/wallet/tx/create' }
  }
}));

vi.mock('@qbit/wallet-state', () => ({
  useBooted: vi.fn(),
  useIsUnlocked: vi.fn()
}));

const ADDRESS = 'qb1zlayoutaccount';

describe('Layout sending a locked page to the unlock screen', () => {
  let isUnlocked = false;
  let state = {
    accounts: { current: { address: ADDRESS } },
    settings: { chainType: ChainType.QBIT_MAINNET }
  };
  // The page's store, as far as Layout reads it.
  const store = {
    getState: () => state,
    subscribe: () => () => undefined,
    dispatch: (action: unknown) => action
  };

  const layout = () => (
    <Provider store={store as never}>
      <Layout />
    </Provider>
  );

  // A screen that mounts with the page's lock state as it is: locked, unless
  // the test unlocked it.
  function mountAt(route: string, page = '/popup.html') {
    window.history.replaceState(null, '', `${page}#${route}`);
    render(layout()).unmount();
  }

  // A screen shown with the wallet unlocked, then a lock.
  function showUnlockedThenLock(route: string, page = '/popup.html') {
    window.history.replaceState(null, '', `${page}#${route}`);
    isUnlocked = true;
    const view = render(layout());
    isUnlocked = false;
    view.rerender(layout());
    view.unmount();
  }

  beforeEach(() => {
    isUnlocked = false;
    state = {
      accounts: { current: { address: ADDRESS } },
      settings: { chainType: ChainType.QBIT_MAINNET }
    };
    vi.mocked(useBooted).mockReturnValue(true);
    vi.mocked(useIsUnlocked).mockImplementation(() => isUnlocked);
  });

  afterEach(() => {
    cleanup();
    forgetInterruptedSendForm();
  });

  it('remembers the send form shown unlocked, with the account and network it was shown for', () => {
    showUnlockedThenLock('/wallet/tx/create');

    expect(window.location.hash).toBe('#/account/unlock');
    expect(getInterruptedSendForm()).toEqual({ address: ADDRESS, chainType: ChainType.QBIT_MAINNET });
  });

  it('remembers the send form shown with a query', () => {
    showUnlockedThenLock('/wallet/tx/create?from=home');

    expect(getInterruptedSendForm()).toBeDefined();
  });

  it.each([['/wallet/tx/confirm'], ['/wallet/tx/consolidate'], ['/main'], ['/settings']])(
    'forgets the send form when a later lock comes on %s',
    (route) => {
      showUnlockedThenLock('/wallet/tx/create');
      expect(getInterruptedSendForm()).toBeDefined();

      showUnlockedThenLock(route);

      expect(window.location.hash).toBe('#/account/unlock');
      expect(getInterruptedSendForm()).toBeUndefined();
    }
  );

  it('never remembers the send form in an approval window', () => {
    showUnlockedThenLock('/wallet/tx/create', '/notification.html');

    expect(window.location.hash).toBe('#/account/unlock');
    expect(getInterruptedSendForm()).toBeUndefined();
  });

  // A page loaded or restored there while locked, or before it knew it was
  // unlocked, or a form reached by Back from the unlock screen.
  it('never remembers a send form that mounted locked, and forgets an earlier one', () => {
    mountAt('/wallet/tx/create');
    expect(window.location.hash).toBe('#/account/unlock');
    expect(getInterruptedSendForm()).toBeUndefined();

    showUnlockedThenLock('/wallet/tx/create');
    expect(getInterruptedSendForm()).toBeDefined();
    mountAt('/wallet/tx/create');

    expect(window.location.hash).toBe('#/account/unlock');
    expect(getInterruptedSendForm()).toBeUndefined();
  });

  it('keeps what it remembered while the page is unlocked or already on the unlock screen', () => {
    showUnlockedThenLock('/wallet/tx/create');
    const remembered = getInterruptedSendForm();
    state = {
      accounts: { current: { address: 'qb1zanotheraccount' } },
      settings: { chainType: ChainType.QBIT_TESTNET4 }
    };

    mountAt('/account/unlock');
    isUnlocked = true;
    mountAt('/main');

    expect(window.location.hash).toBe('#/main');
    expect(getInterruptedSendForm()).toBe(remembered);
  });
});
