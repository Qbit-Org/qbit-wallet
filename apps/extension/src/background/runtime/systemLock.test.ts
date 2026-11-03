import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  walletController: { lockOnSystemEvent: vi.fn() }
}));

vi.mock('@qbit/wallet-background', () => ({ walletController: harness.walletController }));

import { initSystemLock } from './systemLock';

type IdleState = 'active' | 'idle' | 'locked';
type BrowserWindow = { id: number; type: 'normal' | 'popup' | 'devtools' };

/** A browser's idle and windows APIs, as far as the listeners use them. */
function fakeBrowser({ idle = true, windows = true } = {}) {
  const idleListeners: ((state: IdleState) => void)[] = [];
  const removedListeners: ((windowId: number) => void)[] = [];
  const browser = {
    open: [] as BrowserWindow[],
    listError: undefined as { message: string } | undefined,
    runtime: { lastError: undefined as { message: string } | undefined },
    idle: { onStateChanged: { addListener: vi.fn((listener) => idleListeners.push(listener)) } },
    windows: {
      onRemoved: { addListener: vi.fn((listener) => removedListeners.push(listener)) },
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
      browser.open = browser.open.filter((w) => w.id !== id);
      removedListeners.forEach((listener) => listener(id));
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

  it('waits for start-up when the event is what started the worker', async () => {
    const browser = fakeBrowser();
    let finishStartup: () => void = () => undefined;
    initSystemLock(new Promise<void>((resolve) => (finishStartup = resolve)));

    browser.setIdleState('locked');
    await vi.runAllTimersAsync();
    expect(harness.walletController.lockOnSystemEvent).not.toHaveBeenCalled();

    finishStartup();
    await vi.runAllTimersAsync();
    expect(harness.walletController.lockOnSystemEvent).toHaveBeenCalledWith('computer-locked');
  });

  it('locks when the last normal window closes, however many popups stay open', async () => {
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
    expect(browser.windows.getAll).toHaveBeenLastCalledWith({ windowTypes: ['normal'] }, expect.any(Function));
    expect(harness.walletController.lockOnSystemEvent).toHaveBeenCalledTimes(1);
    expect(harness.walletController.lockOnSystemEvent).toHaveBeenCalledWith('windows-closed');

    // Closing the popup with no normal window left locks again; the
    // controller decides whether there is anything to lock.
    browser.closeWindow(3);
    await vi.runAllTimersAsync();
    expect(harness.walletController.lockOnSystemEvent).toHaveBeenCalledTimes(2);
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
