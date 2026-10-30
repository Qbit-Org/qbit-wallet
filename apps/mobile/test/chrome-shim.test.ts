import { afterEach, describe, expect, it, vi } from 'vitest';

import { isExtensionPageSender } from '../../../packages/wallet-background/src/controllers/ui-access';
import { createChromeShim, MOBILE_RUNTIME_ID } from '../src/chrome-shim/install';
import { createRuntimeMessaging, type ShimPort } from '../src/chrome-shim/messaging';
import type { KeyValueBackend } from '../src/chrome-shim/storage';

const ORIGIN = 'capacitor://localhost';
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function memoryBackend(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const backend: KeyValueBackend & { data: Map<string, string>; failNextSet: boolean } = {
    data,
    failNextSet: false,
    keys: async () => [...data.keys()],
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      if (backend.failNextSet) {
        backend.failNextSet = false;
        throw new Error('disk full');
      }
      data.set(key, value);
    },
    remove: async (key) => {
      data.delete(key);
    }
  };
  return backend;
}

function shim(backend = memoryBackend()) {
  return createChromeShim({
    origin: ORIGIN,
    version: '1.2.3',
    os: 'ios',
    backend,
    openExternalUrl: vi.fn(async () => undefined),
    navigateToHash: vi.fn()
  });
}

afterEach(() => vi.restoreAllMocks());

describe('runtime ports', () => {
  const sender = () => ({ id: MOBILE_RUNTIME_ID, url: `${ORIGIN}/sidepanel.html`, origin: ORIGIN });

  it('delivers JSON-serialized copies in order, asynchronously', async () => {
    const messaging = createRuntimeMessaging(sender);
    const received: unknown[] = [];
    messaging.onConnect.addListener((port) => port.onMessage.addListener((m) => received.push(m)));

    const port = messaging.connect({ name: 'popup' });
    const payload = { n: 1, bytes: new Uint8Array([7]), skip: undefined };
    port.postMessage(payload);
    port.postMessage({ n: 2 });
    payload.n = 99;
    expect(received).toEqual([]);

    await tick();
    await tick();
    expect(received).toEqual([{ n: 1, bytes: { 0: 7 } }, { n: 2 }]);
  });

  it('fires onDisconnect on the other end only and rejects later posts', async () => {
    const messaging = createRuntimeMessaging(sender);
    let receiver: ShimPort | undefined;
    messaging.onConnect.addListener((port) => {
      receiver = port;
    });
    const port = messaging.connect(undefined, { name: 'popup' });
    await tick();

    const callerDisconnect = vi.fn();
    const receiverDisconnect = vi.fn();
    port.onDisconnect.addListener(callerDisconnect);
    receiver!.onDisconnect.addListener(receiverDisconnect);

    port.disconnect();
    await tick();
    expect(receiverDisconnect).toHaveBeenCalledTimes(1);
    expect(callerDisconnect).not.toHaveBeenCalled();
    expect(() => port.postMessage({})).toThrow('disconnected port');
    expect(() => receiver!.postMessage({})).toThrow('disconnected port');
  });

  it('disconnects the caller when nothing listens', async () => {
    const messaging = createRuntimeMessaging(sender);
    const port = messaging.connect({ name: 'popup' });
    const onDisconnect = vi.fn();
    port.onDisconnect.addListener(onDisconnect);
    await tick();
    await tick();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('gives the receiving port a sender that passes the wallet UI sender check', async () => {
    const { chrome } = shim();
    vi.stubGlobal('chrome', chrome);
    let receiver: ShimPort | undefined;
    chrome.runtime.onConnect.addListener((port: ShimPort) => {
      receiver = port;
    });
    chrome.runtime.connect({ name: 'popup' });
    await tick();

    expect(isExtensionPageSender(receiver!.sender)).toBe(true);
    expect(isExtensionPageSender({ ...receiver!.sender, url: 'https://evil.example/' })).toBe(false);
    expect(isExtensionPageSender({ ...receiver!.sender, id: 'other' })).toBe(false);
  });

  it('answers sendMessage through an async listener that returns true', async () => {
    const messaging = createRuntimeMessaging(sender);
    messaging.onMessage.addListener((message, _sender, sendResponse) => {
      setTimeout(() => sendResponse({ echo: message.value }), 5);
      return true;
    });
    await expect(messaging.sendMessage({ value: 4 })).resolves.toEqual({ echo: 4 });

    const callback = vi.fn();
    expect(messaging.sendMessage({ value: 5 }, callback)).toBeUndefined();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({ echo: 5 }));
  });
});

describe('storage.local', () => {
  it('loads persisted JSON values and supports every get form', async () => {
    const { storageLocal } = shim(memoryBackend({ a: '1', b: '{"x":true}' }));
    await storageLocal.load();

    await expect(storageLocal.get(null)).resolves.toEqual({ a: 1, b: { x: true } });
    await expect(storageLocal.get('a')).resolves.toEqual({ a: 1 });
    await expect(storageLocal.get(['a', 'missing'])).resolves.toEqual({ a: 1 });
    await expect(storageLocal.get({ a: 0, c: 'fallback' })).resolves.toEqual({ a: 1, c: 'fallback' });
  });

  it('persists before updating reads, and keeps the old value when a write fails', async () => {
    const backend = memoryBackend();
    const { storageLocal } = shim(backend);
    await storageLocal.load();

    await storageLocal.set({ vault: 'v1' });
    expect(backend.data.get('vault')).toBe('"v1"');

    backend.failNextSet = true;
    await expect(storageLocal.set({ vault: 'v2' })).rejects.toThrow('disk full');
    await expect(storageLocal.get('vault')).resolves.toEqual({ vault: 'v1' });
    expect(backend.data.get('vault')).toBe('"v1"');
  });

  it('applies queued writes in call order', async () => {
    const { storageLocal } = shim();
    await storageLocal.load();
    const writes = [storageLocal.set({ k: 1 }), storageLocal.set({ k: 2 }), storageLocal.remove('k'), storageLocal.set({ k: 3 })];
    await Promise.all(writes);
    await expect(storageLocal.get('k')).resolves.toEqual({ k: 3 });
  });

  it('reports callback failures on runtime.lastError only while the callback runs', async () => {
    const backend = memoryBackend();
    const { chrome, storageLocal } = shim(backend);
    await storageLocal.load();
    backend.failNextSet = true;

    const seen = await new Promise<unknown>((resolve) => {
      storageLocal.set({ k: 1 }, () => resolve(chrome.runtime.lastError));
    });
    expect(seen).toEqual({ message: 'disk full' });
    expect(chrome.runtime.lastError).toBeUndefined();

    const value = await new Promise((resolve) => storageLocal.get(['k'], resolve));
    expect(value).toEqual({});
  });
});

describe('tabs and windows', () => {
  it('routes internal pages to a hash change and web links to the system browser', async () => {
    const host = {
      origin: ORIGIN,
      version: '1',
      os: 'ios',
      backend: memoryBackend(),
      openExternalUrl: vi.fn(async () => undefined),
      navigateToHash: vi.fn()
    };
    const { chrome } = createChromeShim(host);

    await chrome.tabs.create({ url: chrome.runtime.getURL('index.html#/settings') });
    expect(host.navigateToHash).toHaveBeenCalledWith('#/settings');

    await chrome.tabs.create({ url: 'https://mempool.qbit.org/tx/abc' });
    expect(host.openExternalUrl).toHaveBeenCalledWith('https://mempool.qbit.org/tx/abc');

    await expect(chrome.tabs.create({ url: 'file:///etc/hosts' })).rejects.toThrow('Unsupported URL scheme');
  });

  it('refuses separate windows and grants no optional permissions', async () => {
    const { chrome } = shim();
    await expect(chrome.windows.create()).rejects.toThrow('not available');
    await expect(chrome.permissions.contains({ origins: ['http://127.0.0.1:3002/*'] })).resolves.toBe(false);
    expect(chrome.runtime.getManifest()).toMatchObject({ manifest_version: 3, version: '1.2.3' });
  });
});
