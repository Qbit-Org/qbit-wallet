import { createSettle, trailingCallback, type LastErrorHolder } from './callbacks';
import { ShimEvent } from './events';
import { createRuntimeMessaging, type MessageSender } from './messaging';
import { ShimStorageArea, type KeyValueBackend } from './storage';

/**
 * Builds the subset of the extension `chrome.*` API that the wallet's
 * background and UI use, so both can run unchanged inside one app WebView.
 *
 * APIs with no mobile meaning (tabs, windows, side panel, host permissions,
 * notifications) answer the way Chrome does when nothing is there: empty tab
 * lists, permissions not granted, no-op notifications. Opening a separate
 * window is the one call that fails, because the only callers are dApp
 * approval popups, and a dApp cannot reach the app yet.
 */

export const MOBILE_RUNTIME_ID = 'qbit-mobile-app';
export const MOBILE_PAGE = 'sidepanel.html';

export interface ShimHost {
  /** Page origin, e.g. `capacitor://localhost`. */
  origin: string;
  version: string;
  os: string;
  backend: KeyValueBackend;
  openExternalUrl(url: string): Promise<void>;
  /** Moves the single app page to a hash route such as `#/settings`. */
  navigateToHash(hash: string): void;
}

const SINGLE_TAB = { id: 1, index: 0, windowId: 1, active: true, highlighted: true, pinned: false, incognito: false };

export function createChromeShim(host: ShimHost) {
  const getURL = (path = '') => `${host.origin}/${path.replace(/^\/+/, '')}`;
  const sender = (): MessageSender => ({
    id: MOBILE_RUNTIME_ID,
    url: typeof location !== 'undefined' ? location.href : getURL(MOBILE_PAGE),
    origin: host.origin
  });
  const messaging = createRuntimeMessaging(sender);

  const manifest = {
    manifest_version: 3,
    name: 'Qbit Wallet',
    version: host.version,
    permissions: ['storage'],
    host_permissions: [] as string[],
    optional_host_permissions: [] as string[]
  };

  const openUrl = async (url: string) => {
    const internalPrefix = getURL('');
    if (url.startsWith(internalPrefix) || !/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      const hashIndex = url.indexOf('#');
      host.navigateToHash(hashIndex >= 0 ? url.slice(hashIndex) : '#/');
      return;
    }
    if (/^https?:\/\//i.test(url)) {
      await host.openExternalUrl(url);
      return;
    }
    throw new Error(`Unsupported URL scheme: ${url}`);
  };

  // Callback failures are reported on runtime.lastError, so runtime holds it.
  const lastErrorHolder: LastErrorHolder = { lastError: undefined };
  const settle = createSettle(lastErrorHolder);
  const promiseOrCallback = <T>(promise: Promise<T>, args: unknown[]) => settle(promise, trailingCallback(args));
  const storageLocal = new ShimStorageArea(host.backend, settle);

  const runtime = {
    id: MOBILE_RUNTIME_ID,
    get lastError() {
      return lastErrorHolder.lastError;
    },
    getURL,
    getManifest: () => manifest,
    getPlatformInfo: (...args: any[]) => promiseOrCallback(Promise.resolve({ os: host.os, arch: 'arm' }), args),
    reload: () => location.reload(),
    connect: messaging.connect,
    onConnect: messaging.onConnect,
    sendMessage: messaging.sendMessage,
    onMessage: messaging.onMessage,
    onInstalled: new ShimEvent<(details: { reason: string }) => void>(),
    onStartup: new ShimEvent<() => void>()
  };

  const tabs = {
    TAB_ID_NONE: -1,
    query: (...args: any[]) => promiseOrCallback(Promise.resolve([]), args),
    get: (tabId: number, ...args: any[]) =>
      promiseOrCallback(Promise.reject(new Error(`No tab with id: ${tabId}.`)), args),
    getCurrent: (...args: any[]) => promiseOrCallback(Promise.resolve(undefined), args),
    create: (props: { url?: string }, ...args: any[]) =>
      promiseOrCallback(
        (async () => {
          if (props?.url) await openUrl(props.url);
          return { ...SINGLE_TAB, url: props?.url };
        })(),
        args
      ),
    update: (_tabId: number, props: { url?: string }, ...args: any[]) =>
      promiseOrCallback(
        (async () => {
          if (props?.url) await openUrl(props.url);
          return SINGLE_TAB;
        })(),
        args
      ),
    remove: (_tabIds: number | number[], ...args: any[]) => promiseOrCallback(Promise.resolve(), args),
    sendMessage: () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')),
    onUpdated: new ShimEvent<(...args: any[]) => void>(),
    onRemoved: new ShimEvent<(...args: any[]) => void>(),
    onActivated: new ShimEvent<(...args: any[]) => void>()
  };

  const windows = {
    WINDOW_ID_NONE: -1,
    getCurrent: (...args: any[]) =>
      promiseOrCallback(Promise.resolve({ id: 1, focused: true, type: 'normal', state: 'fullscreen' }), args),
    create: () => Promise.reject(new Error('Separate windows are not available in the mobile app')),
    update: (_windowId: number, _info: unknown, ...args: any[]) =>
      promiseOrCallback(Promise.resolve({ id: 1, focused: true }), args),
    remove: (_windowId: number, ...args: any[]) => promiseOrCallback(Promise.resolve(), args),
    onRemoved: new ShimEvent<(windowId: number) => void>(),
    onFocusChanged: new ShimEvent<(windowId: number) => void>()
  };

  const permissions = {
    contains: (_p: unknown, ...args: any[]) => promiseOrCallback(Promise.resolve(false), args),
    request: (_p: unknown, ...args: any[]) => promiseOrCallback(Promise.resolve(false), args),
    remove: (_p: unknown, ...args: any[]) => promiseOrCallback(Promise.resolve(false), args),
    onAdded: new ShimEvent<(...args: any[]) => void>(),
    onRemoved: new ShimEvent<(...args: any[]) => void>()
  };

  const notifications = {
    create: (...args: any[]) => promiseOrCallback(Promise.resolve(typeof args[0] === 'string' ? args[0] : ''), args),
    clear: (_id: string, ...args: any[]) => promiseOrCallback(Promise.resolve(true), args),
    getAll: (...args: any[]) => promiseOrCallback(Promise.resolve({}), args)
  };

  const chromeShim = {
    runtime,
    storage: { local: storageLocal },
    tabs,
    windows,
    permissions,
    notifications,
    // The extension reads its own _locales through this; the UI uses i18next.
    i18n: { getMessage: () => '', getUILanguage: () => navigator.language }
  };

  return { chrome: chromeShim, storageLocal };
}

/**
 * Loads persisted storage, then publishes the shim as the global `chrome`.
 * Must complete before any wallet module is evaluated: several read
 * `chrome` while their module body runs.
 */
export async function installChromeShim(host: ShimHost) {
  const shim = createChromeShim(host);
  await shim.storageLocal.load();
  Object.defineProperty(globalThis, 'chrome', { value: shim.chrome, configurable: true, writable: true });
  return shim;
}
