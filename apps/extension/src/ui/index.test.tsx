import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, fireEvent, screen } from '@testing-library/react';

import { unhandledRejectionsDuring } from '../../../../tests/support/unhandledRejections';

// The page as the entry module sees it through its mocked imports: the wallet
// proxy, the idle timer's action handler, and the roots it renders into.
const page = vi.hoisted(() => {
  const page = {
    // What the background gives the page's setLastActiveTime call.
    reply: (): Promise<void> => new Promise<void>(() => undefined),
    // Counts those calls. The wallet's method is a plain function around it:
    // a spy attaches handlers to the promises it returns, which would hide a
    // rejection that the page leaves unhandled.
    setLastActiveTime: vi.fn(),
    wallet: {
      getBackgroundStartupStatus: vi.fn(),
      setLastActiveTime: (...args: unknown[]): Promise<void> => {
        page.setLastActiveTime(...args);
        return page.reply();
      }
    },
    platformEnv: { READY_TO_RENDER: false },
    events: [] as string[],
    onIdleAction: undefined as undefined | (() => void),
    remount: undefined as undefined | (() => void),
    roots: [] as Array<{ unmount(): void }>
  };
  return page;
});

const passThrough = vi.hoisted(() => async () => {
  const { createElement, Fragment } = await import('react');
  return function PassThrough({ children }: { children?: ReactNode }) {
    return createElement(Fragment, null, children);
  };
});

vi.mock('react-dom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom/client')>();
  const createRoot: typeof actual.createRoot = (container, options) => {
    const root = actual.createRoot(container, options);
    page.roots.push(root);
    return root;
  };
  return { ...actual, createRoot, default: { ...actual, createRoot } };
});

// The idle timer's own handling of keys, the mouse, focus and visibility is
// left out: it only hands over its action handler.
vi.mock('react-idle-timer', async () => {
  const { createElement, Fragment } = await import('react');
  return {
    IdleTimerProvider: ({ onAction, children }: { onAction: () => void; children?: ReactNode }) => {
      page.onIdleAction = onAction;
      return createElement(Fragment, null, children);
    }
  };
});

// A small app on the same router as the wallet's, three screens in a ring.
vi.mock('./pages/MainRoute', async () => {
  const { createElement } = await import('react');
  const { HashRouter, Link, Route, Routes } = await import('react-router-dom');
  const screenAt = (name: string, next: string) =>
    createElement(
      'main',
      null,
      createElement('h1', { 'data-testid': 'route' }, name),
      createElement(Link, { to: next }, 'next')
    );
  return {
    default: () =>
      createElement(
        HashRouter,
        null,
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/', element: screenAt('home', '/send') }),
          createElement(Route, { path: '/send', element: screenAt('send', '/settings') }),
          createElement(Route, { path: '/settings', element: screenAt('settings', '/') })
        )
      )
  };
});

vi.mock('./components/StartupErrorScreen', async () => {
  const { createElement } = await import('react');
  return {
    StartupErrorScreen: ({ reason }: { reason: string }) =>
      createElement('p', { 'data-testid': 'startup-error' }, reason)
  };
});

// Mounts the whole app again on page.remount().
vi.mock('./providers/ThemeProvider', async () => {
  const { createElement, Fragment, useState } = await import('react');
  return {
    ThemeProvider: function ThemeProvider({ children }: { children?: ReactNode }) {
      const [mount, setMount] = useState(0);
      page.remount = () => setMount((count) => count + 1);
      return createElement(Fragment, { key: mount }, children);
    }
  };
});

vi.mock('react-redux', async () => ({ Provider: await passThrough() }));
vi.mock('@qbit/wallet-state', async () => ({
  AccountUpdater: () => null,
  createAppStore: () => ({}),
  WalletProvider: await passThrough()
}));
vi.mock('@qbit/wallet-shared', () => ({ PlatformEnv: page.platformEnv }));
vi.mock('@/shared/initPlatformEnv', () => ({ initPlatformEnv: () => undefined }));
vi.mock('@/shared/utils/i18n', () => ({ i18nService: { init: () => undefined } }));
vi.mock('@/ui/styles/global.less', () => ({}));
vi.mock('./components/Responsive', async () => ({ AppDimensions: await passThrough() }));
vi.mock('./providers/DeviceProvider', async () => ({ DeviceProvider: await passThrough() }));
vi.mock('./providers/I18nProvider', async () => ({ I18nProvider: await passThrough() }));
vi.mock('./providers/ToolsProvider', async () => ({ ToolsProvider: await passThrough() }));
vi.mock('./utils/appConfig', () => ({ initializeAppConfig: () => undefined }));
vi.mock('./utils/platformFixes', () => ({ applyExternalMonitorFix: () => undefined }));
vi.mock('./web/ui-messaging', () => ({
  createPortMessageChannel: () => ({}),
  createWalletProxy: () => page.wallet,
  setupEventBusListeners: () => undefined
}));

// Load the entry module as a fresh page at `pathname`, and let it run until it
// waits on a timer.
async function openPage(pathname: string) {
  window.history.replaceState(null, '', pathname);
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  await act(async () => {
    await import('./index');
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const shownRoute = () => screen.getByTestId('route').textContent;

describe('the wallet page entry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    page.platformEnv.READY_TO_RENDER = false;
    page.events.length = 0;
    page.onIdleAction = undefined;
    page.remount = undefined;
    page.wallet.getBackgroundStartupStatus.mockImplementation(async () => {
      page.events.push('status:ready');
      return { state: 'ready' };
    });
    page.setLastActiveTime.mockImplementation(() => page.events.push('setLastActiveTime'));
    // The background has not answered yet.
    page.reply = () => new Promise<void>(() => undefined);
  });

  afterEach(async () => {
    await act(async () => {
      for (const root of page.roots.splice(0)) root.unmount();
    });
    document.body.innerHTML = '';
    window.history.replaceState(null, '', '/');
    vi.useRealTimers();
  });

  it.each(['/popup.html', '/sidepanel.html'])(
    'counts opening %s as one screen action, without waiting for its answer to render',
    async (pathname) => {
      await openPage(pathname);

      expect(shownRoute()).toBe('home');
      expect(page.setLastActiveTime).toHaveBeenCalledTimes(1);
      expect(page.setLastActiveTime).toHaveBeenCalledWith();
    }
  );

  it('counts the opening only once start-up has finished', async () => {
    const starting = async () => {
      page.events.push('status:starting');
      return { state: 'starting' };
    };
    page.wallet.getBackgroundStartupStatus.mockImplementationOnce(starting).mockImplementationOnce(starting);

    await openPage('/popup.html');
    expect(page.events).toEqual(['status:starting']);
    expect(screen.queryByTestId('route')).toBeNull();

    await wait(50 + 100);
    expect(page.events).toEqual(['status:starting', 'status:starting', 'status:ready', 'setLastActiveTime']);
    expect(shownRoute()).toBe('home');
  });

  it.each(['/notification.html', '/index.html'])(
    'does not count loading %s, which a site can cause',
    async (pathname) => {
      await openPage(pathname);
      await wait(10 * 60_000);

      expect(shownRoute()).toBe('home');
      expect(page.setLastActiveTime).not.toHaveBeenCalled();
    }
  );

  it('counts the opening once, whatever happens in the page after it', async () => {
    await openPage('/popup.html');
    expect(page.setLastActiveTime).toHaveBeenCalledTimes(1);

    // A route change from a link in the app.
    fireEvent.click(screen.getByRole('link'));
    expect(shownRoute()).toBe('send');
    // A route change by the address, as a hash link or a redirect to the lock
    // screen makes.
    await act(async () => {
      window.history.pushState(null, '', '#/settings');
      window.dispatchEvent(new PopStateEvent('popstate'));
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(shownRoute()).toBe('settings');
    // Focus and visibility changes.
    act(() => {
      window.dispatchEvent(new FocusEvent('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new PageTransitionEvent('pageshow'));
    });
    // The whole app mounted again.
    const shownBefore = screen.getByTestId('route');
    act(() => page.remount?.());
    expect(screen.getByTestId('route')).not.toBe(shownBefore);
    expect(shownRoute()).toBe('settings');
    await wait(10 * 60_000);

    expect(page.setLastActiveTime).toHaveBeenCalledTimes(1);
  });

  it('still counts each action the idle timer reports, in any page', async () => {
    await openPage('/notification.html');
    expect(page.setLastActiveTime).not.toHaveBeenCalled();

    act(() => page.onIdleAction?.());
    act(() => page.onIdleAction?.());

    expect(page.setLastActiveTime).toHaveBeenCalledTimes(2);
  });

  it('counts each action the idle timer reports as one screen action, without waiting for its answer', async () => {
    await openPage('/notification.html');
    expect(shownRoute()).toBe('home');
    expect(page.events).toEqual(['status:ready']);

    act(() => page.onIdleAction?.());
    expect(page.setLastActiveTime).toHaveBeenCalledTimes(1);
    act(() => page.onIdleAction?.());

    expect(page.events).toEqual(['status:ready', 'setLastActiveTime', 'setLastActiveTime']);
    expect(page.setLastActiveTime.mock.calls).toEqual([[], []]);
  });

  it.each([
    [
      'rejects with a plain object, as for a wallet that is locking',
      () => Promise.reject({ message: 'The wallet is locking.', stack: 'at lockWallet' })
    ],
    [
      'throws, as the port does with every request id in use',
      () => {
        throw Object.assign(new Error('Request limit exceeded.'), { code: -32005 });
      }
    ]
  ])('keeps the page, leaves nothing unhandled and asks only once per action when the call %s', async (_, failure) => {
    await openPage('/notification.html');
    page.reply = failure;

    const unhandled = await unhandledRejectionsDuring(async () => {
      expect(() => act(() => page.onIdleAction?.())).not.toThrow();
      expect(() => act(() => page.onIdleAction?.())).not.toThrow();
      await wait(10 * 60_000);
    });

    expect(unhandled).toEqual([]);
    expect(page.setLastActiveTime).toHaveBeenCalledTimes(2);
    expect(shownRoute()).toBe('home');
  });

  it.each([
    [
      'rejects with a plain object, as for a wallet that is locking',
      () => Promise.reject({ message: 'The wallet is locking.', stack: 'at lockWallet' })
    ],
    [
      'throws, as the port does with every request id in use',
      () => {
        throw Object.assign(new Error('Request limit exceeded.'), { code: -32005 });
      }
    ]
  ])('renders, leaves nothing unhandled and asks only once when the call %s', async (_, failure) => {
    page.reply = failure;

    const unhandled = await unhandledRejectionsDuring(async () => {
      await openPage('/popup.html');
      await wait(10 * 60_000);
    });

    expect(unhandled).toEqual([]);
    expect(shownRoute()).toBe('home');
    expect(page.setLastActiveTime).toHaveBeenCalledTimes(1);
  });

  it('does not count the opening when start-up failed', async () => {
    page.wallet.getBackgroundStartupStatus.mockImplementation(async () => ({
      state: 'failed',
      reason: 'stored-settings-unreadable'
    }));

    await openPage('/popup.html');
    await wait(10 * 60_000);

    expect(screen.getByTestId('startup-error').textContent).toBe('stored-settings-unreadable');
    expect(screen.queryByTestId('route')).toBeNull();
    expect(page.setLastActiveTime).not.toHaveBeenCalled();
  });
});
