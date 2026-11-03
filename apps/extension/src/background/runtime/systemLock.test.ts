import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  walletController: { lockOnSystemEvent: vi.fn(), lockIfAutoLockOverdue: vi.fn() }
}));

vi.mock('@qbit/wallet-background', () => ({ walletController: harness.walletController }));

import { initSystemLock } from './systemLock';

type IdleState = 'active' | 'idle' | 'locked';
type BrowserWindow = { id: number; type: 'normal' | 'popup' | 'app' | 'devtools' };

type WindowFilter = { windowTypes: BrowserWindow['type'][] };

/**
 * A browser's idle and windows APIs, as far as the listeners use them. Like
 * Chrome's, windows.onRemoved reports only `normal` and `popup` windows to a
 * listener added without a filter; `eventFilters: false` is a browser whose
 * windows events take none.
 */
function fakeBrowser({ idle = true, windows = true, eventFilters = true } = {}) {
  const idleListeners: ((state: IdleState) => void)[] = [];
  const removedListeners: { listener: (windowId: number) => void; windowTypes: BrowserWindow['type'][] }[] = [];
  const browser = {
    open: [] as BrowserWindow[],
    listError: undefined as { message: string } | undefined,
    runtime: { lastError: undefined as { message: string } | undefined },
    idle: { onStateChanged: { addListener: vi.fn((listener) => idleListeners.push(listener)) } },
    windows: {
      onRemoved: {
        addListener: vi.fn((listener: (windowId: number) => void, filter?: WindowFilter) => {
          if (filter && !eventFilters) throw new Error('This event does not support filters.');
          removedListeners.push({ listener, windowTypes: filter?.windowTypes ?? ['normal', 'popup'] });
        })
      },
      getAll: vi.fn(
        ({ windowTypes }: { windowTypes: BrowserWindow['type'][] }, callback: (found: BrowserWindow[]) => void) => {
          // Answers later, as the browser does.
          setTimeout(() => {
            browser.runtime.lastError = browser.listError;
            callback(browser.listError ? (undefined as never) : browser.open.filter((w) => windowTypes.includes(w.type)));
            browser.runtime.lastError = undefined;
          }, 0);
        }
      )
    },
    setIdleState: (state: IdleState) => idleListeners.forEach((listener) => listener(state)),
    closeWindow: (id: number) => {
      const closed = browser.open.find((w) => w.id === id);
      browser.open = browser.open.filter((w) => w.id !== id);
      for (const { listener, windowTypes } of removedListeners) {
        if (closed && windowTypes.includes(closed.type)) listener(id);
      }
    }
  };
  vi.stubGlobal('chrome', {
    runtime: browser.runtime,
    ...(idle ? { idle: browser.idle } : {}),
    ...(windows ? { windows: browser.windows } : {})
  });
  return browser;
}

const started = () => Promise.resolve();

describe('initSystemLock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    harness.walletController.lockOnSystemEvent.mockResolvedValue(true);
    harness.walletController.lockIfAutoLockOverdue.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('adds both listeners at once, before start-up finishes', () => {
    const browser = fakeBrowser();
    initSystemLock(new Promise(() => undefined));
    expect(browser.idle.onStateChanged.addListener).toHaveBeenCalledTimes(1);
    expect(browser.windows.onRemoved.addListener).toHaveBeenCalledTimes(1);
  });

  it('locks when the computer locks, and not when it only goes idle or becomes active', async () => {
    const browser = fakeBrowser();
    initSystemLock(started());

    browser.setIdleState('idle');
    browser.setIdleState('active');
    await vi.runAllTimersAsync();
    expect(harness.walletController.lockOnSystemEvent).not.toHaveBeenCalled();

    browser.setIdleState('locked');
    await vi.runAllTimersAsync();
    expect(harness.walletController.lockOnSystemEvent).toHaveBeenCalledTimes(1);
    expect(harness.walletController.lockOnSystemEvent).toHaveBeenCalledWith('computer-locked');
  });

  it('applies an overdue auto-lock on every change of the idle state, waking included', async () => {
    const browser = fakeBrowser();
    initSystemLock(started());

    // Waking from sleep: the user is back, the paused timer has not run out.
    browser.setIdleState('active');
    await vi.runAllTimersAsync();
    expect(harness.walletController.lockIfAutoLockOverdue).toHaveBeenCalledTimes(1);
    expect(harness.walletController.lockOnSystemEvent).not.toHaveBeenCalled();

    browser.setIdleState('idle');
    browser.setIdleState('locked');
    await vi.runAllTimersAsync();
    expect(harness.walletController.lockIfAutoLockOverdue).toHaveBeenCalledTimes(3);
    expect(harness.walletController.lockOnSystemEvent).toHaveBeenCalledWith('computer-locked');
  });

  it('waits for start-up when the event is what started the worker', async () => {
    const browser = fakeBrowser();
    let finishStartup: () => void = () => undefined;
    initSystemLock(new Promise<void>((resolve) => (finishStartup = resolve)));

    browser.setIdleState('locked');
    await vi.runAllTimersAsync();
    expect(harness.walletController.lockOnSystemEvent).not.toHaveBeenCalled();

    expect(harness.walletController.lockIfAutoLockOverdue).not.toHaveBeenCalled();

    finishStartup();
    await vi.runAllTimersAsync();
    expect(harness.walletController.lockOnSystemEvent).toHaveBeenCalledWith('computer-locked');
    expect(harness.walletController.lockIfAutoLockOverdue).toHaveBeenCalledTimes(1);
  });

  it('locks when the last browser window closes, however many popups stay open', async () => {
    const browser = fakeBrowser();
    browser.open = [
      { id: 1, type: 'normal' },
      { id: 2, type: 'normal' },
      // The wallet's own approval window, and developer tools.
      { id: 3, type: 'popup' },
      { id: 4, type: 'devtools' }
    ];
    initSystemLock(started());

    browser.closeWindow(1);
    await vi.runAllTimersAsync();
    expect(harness.walletController.lockOnSystemEvent).not.toHaveBeenCalled();

    browser.closeWindow(2);
    await vi.runAllTimersAsync();
    expect(browser.windows.getAll).toHaveBeenLastCalledWith({ windowTypes: ['normal', 'app'] }, expect.any(Function));
    expect(harness.walletController.lockOnSystemEvent).toHaveBeenCalledTimes(1);
    expect(harness.walletController.lockOnSystemEvent).toHaveBeenCalledWith('windows-closed');

    // Closing the popup with no normal window left locks again; the
    // controller decides whether there is anything to lock.
    browser.closeWindow(3);
    await vi.runAllTimersAsync();
    expect(harness.walletController.lockOnSystemEvent).toHaveBeenCalledTimes(2);
  });

  it('counts an installed web app as an open window', async () => {
    const browser = fakeBrowser();
    // A dapp installed as an app is the user's only window, beside an approval.
    browser.open = [
      { id: 1, type: 'app' },
      { id: 2, type: 'popup' }
    ];
    initSystemLock(started());

    browser.closeWindow(2);
    await vi.runAllTimersAsync();
    expect(harness.walletController.lockOnSystemEvent).not.toHaveBeenCalled();

    browser.closeWindow(1);
    await vi.runAllTimersAsync();
    expect(harness.walletController.lockOnSystemEvent).toHaveBeenCalledWith('windows-closed');
  });

  it('locks when an app window that outlived the last normal window closes', async () => {
    const browser = fakeBrowser();
    browser.open = [
      { id: 1, type: 'normal' },
      { id: 2, type: 'app' }
    ];
    initSystemLock(started());
    // Without the filter the browser would not report the app window closing.
    expect(browser.windows.onRemoved.addListener).toHaveBeenCalledWith(expect.any(Function), {
      windowTypes: ['normal', 'popup', 'app']
    });

    browser.closeWindow(1);
    await vi.runAllTimersAsync();
    expect(harness.walletController.lockOnSystemEvent).not.toHaveBeenCalled();

    browser.closeWindow(2);
    await vi.runAllTimersAsync();
    expect(harness.walletController.lockOnSystemEvent).toHaveBeenCalledWith('windows-closed');
  });

  it('still listens, without a filter, in a browser whose windows events take none', async () => {
    const browser = fakeBrowser({ eventFilters: false });
    browser.open = [{ id: 1, type: 'normal' }];
    initSystemLock(started());
    expect(browser.windows.onRemoved.addListener).toHaveBeenLastCalledWith(expect.any(Function));

    browser.closeWindow(1);
    await vi.runAllTimersAsync();
    expect(harness.walletController.lockOnSystemEvent).toHaveBeenCalledWith('windows-closed');
  });

  it('locks when the windows cannot be listed', async () => {
    const browser = fakeBrowser();
    browser.open = [{ id: 1, type: 'normal' }, { id: 2, type: 'normal' }];
    browser.listError = { message: 'No browser context' };
    initSystemLock(started());

    browser.closeWindow(1);
    await vi.runAllTimersAsync();
    expect(harness.walletController.lockOnSystemEvent).toHaveBeenCalledWith('windows-closed');
  });

  it('logs a lock that fails instead of leaving it unhandled', async () => {
    const browser = fakeBrowser();
    harness.walletController.lockOnSystemEvent.mockRejectedValue(new Error('storage gone'));
    const log = (await import('loglevel')).default;
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    initSystemLock(started());

    browser.setIdleState('locked');
    await vi.runAllTimersAsync();
    expect(error).toHaveBeenCalledWith('[Background] Lock on computer-locked failed', expect.any(Error));

    harness.walletController.lockIfAutoLockOverdue.mockRejectedValue(new Error('storage gone'));
    browser.setIdleState('active');
    await vi.runAllTimersAsync();
    expect(error).toHaveBeenCalledWith('[Background] Overdue auto-lock failed', expect.any(Error));
    error.mockRestore();
  });

  it('adds only the listeners the browser has an API for', async () => {
    const withoutIdle = fakeBrowser({ idle: false });
    expect(() => initSystemLock(started())).not.toThrow();
    expect(withoutIdle.windows.onRemoved.addListener).toHaveBeenCalledTimes(1);

    const withoutWindows = fakeBrowser({ windows: false });
    expect(() => initSystemLock(started())).not.toThrow();
    expect(withoutWindows.idle.onStateChanged.addListener).toHaveBeenCalledTimes(1);

    vi.stubGlobal('chrome', undefined);
    expect(() => initSystemLock(started())).not.toThrow();
  });
});
