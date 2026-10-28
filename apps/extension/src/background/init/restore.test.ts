import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProxyStorageAdapter } from '@qbit/wallet-storage';
import { ChainType } from '@qbit/wallet-types';

type ServiceConfig = { storage: ProxyStorageAdapter };

// chrome.storage.local as 1.0.6 leaves it for an onboarded wallet.
const STORE_1_0_6 = {
  i18nextLng: 'fr',
  keyringState: { booted: 'encrypted-boot-marker', vault: 'encrypted-vault', boostValue: 0 },
  preference: {
    currentKeyringIndex: 0,
    chainType: ChainType.QBIT_MAINNET,
    locale: 'fr',
    autoLockTimeId: 5,
    themeMode: 'dark'
  },
  biometricUnlock: null,
  openapi: null,
  permission: { dumpCache: [['https://dapp.example', { origin: 'https://dapp.example', isConnected: true }]] },
  contactBook: { contacts: { qb1contact: { name: 'Alice', address: 'qb1contact' } } },
  notifications: { notifications: [] }
};

const browserStorage = vi.hoisted(() => ({
  disk: {} as Record<string, unknown>,
  get: vi.fn(),
  set: vi.fn()
}));

vi.mock('../webapi/browser', () => ({
  browserStorageLocalGet: browserStorage.get,
  browserStorageLocalSet: browserStorage.set
}));

const background = vi.hoisted(() => {
  // Each service reads what it keeps through the storage adapter it is given,
  // the way the real one does at init.
  const reads =
    (key: string) =>
    async ({ storage }: ServiceConfig) => {
      await storage.get(key);
    };
  return {
    bgEventBus: {},
    biometricUnlockService: { init: vi.fn(reads('biometricUnlock')) },
    contactBookService: { init: vi.fn(reads('contactBook')) },
    keyringService: { init: vi.fn(reads('keyringState')) },
    notificationService: { init: vi.fn(reads('notifications')) },
    permissionService: { init: vi.fn(reads('permission')) },
    phishingDetectService: { init: vi.fn() },
    preferenceService: {
      // createPersistentProxy writes its template only for a key that is absent.
      init: vi.fn(async ({ storage }: ServiceConfig) => {
        await storage.createPersistentProxy('preference', { chainType: 'QBIT_MAINNET', locale: 'en' });
      }),
      getChainType: vi.fn(),
      setChainType: vi.fn()
    },
    qbitSendGuardService: { init: vi.fn() },
    // Clears its key on every start, as the real one does.
    walletApiService: {
      init: vi.fn(async ({ storage }: ServiceConfig) => {
        await storage.set('openapi', null);
      })
    },
    walletController: {
      initRegtestAccess: vi.fn(),
      prepareStartupChainType: vi.fn(),
      setBackgroundInited: vi.fn(),
      setBackgroundStartupFailed: vi.fn()
    }
  };
});

vi.mock('@qbit/wallet-background', () => background);
vi.mock('@qbit-oss/pqc', () => ({ init: vi.fn() }));
vi.mock('@qbit-oss/pqc/wasm/pqc.mjs', () => ({ default: vi.fn() }));
vi.mock('@qbit/phishing-detect', () => ({ ExtensionAdapter: class {} }));
vi.mock('../regtest/regtestAccessAdapter', () => ({
  createLockedRegtestAccessAdapter: vi.fn(),
  createRegtestAccessAdapter: vi.fn()
}));
vi.mock('../utils/encryptor', () => ({ encryptor: {} }));
vi.mock('../utils/http-client/httpClient', () => ({ HttpClient: class {} }));

// A fresh module graph is what a restarted service worker gets.
const startWorker = async () => {
  vi.resetModules();
  const restore = await import('./restore');
  await restore.restoreAppState();
  return restore;
};

// What Chrome reports when another process holds the storage database's lock.
const unreadable = () =>
  new Error('IO error: .../Local Extension Settings/LOCK: File currently in use. (ChromeMethodBFE: 15::LockFile::2)');

describe('restoreAppState', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ json: async () => ({}) }))
    );
    browserStorage.disk = structuredClone(STORE_1_0_6);
    browserStorage.get.mockImplementation(async () => structuredClone(browserStorage.disk));
    browserStorage.set.mockImplementation(async (items: Record<string, unknown>) => {
      Object.assign(browserStorage.disk, structuredClone(items));
    });
    background.walletController.prepareStartupChainType.mockResolvedValue(ChainType.QBIT_MAINNET);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports that the stored settings could not be read, and writes nothing, when the storage read fails', async () => {
    browserStorage.get.mockRejectedValue(unreadable());

    const { isAppStateRestored } = await startWorker();

    expect(background.walletController.setBackgroundStartupFailed).toHaveBeenCalledWith('stored-settings-unreadable');
    expect(background.walletController.setBackgroundInited).not.toHaveBeenCalled();
    expect(isAppStateRestored()).toBe(false);
    expect(background.keyringService.init).not.toHaveBeenCalled();
    expect(browserStorage.set).not.toHaveBeenCalled();
    expect(browserStorage.disk).toEqual(STORE_1_0_6);
  });

  it('starts normally from the same 1.0.6 store after a restart once it can be read, with no write in between', async () => {
    browserStorage.get.mockRejectedValue(unreadable());
    await startWorker();
    expect(background.walletController.setBackgroundStartupFailed).toHaveBeenCalledWith('stored-settings-unreadable');
    expect(browserStorage.set).not.toHaveBeenCalled();

    // Retry restarts the worker; the store is readable again and unchanged.
    browserStorage.get.mockImplementation(async () => structuredClone(browserStorage.disk));
    const { isAppStateRestored } = await startWorker();

    expect(background.walletController.setBackgroundInited).toHaveBeenCalledWith(true);
    expect(background.walletController.setBackgroundStartupFailed).toHaveBeenCalledTimes(1);
    expect(isAppStateRestored()).toBe(true);
    expect(background.contactBookService.init).toHaveBeenCalledTimes(1);
    // Only the write a normal start makes, and it leaves the value as it was.
    expect(browserStorage.set.mock.calls).toEqual([[{ openapi: null }]]);
    expect(browserStorage.disk).toEqual(STORE_1_0_6);
  });

  it('reports the unreadable store when a service wraps the read error in its own', async () => {
    // Make preference the first reader: it reads through createPersistentProxy,
    // which retries and then rejects with its own error.
    vi.doMock('@/shared/utils/i18n', () => ({ i18nService: { init: vi.fn(), translate: vi.fn() } }));
    background.keyringService.init.mockResolvedValueOnce(undefined);
    browserStorage.get.mockRejectedValue(unreadable());

    try {
      await startWorker();
    } finally {
      vi.doUnmock('@/shared/utils/i18n');
    }

    expect(browserStorage.get.mock.calls.length).toBeGreaterThan(1);
    expect(background.walletController.setBackgroundStartupFailed).toHaveBeenCalledWith('stored-settings-unreadable');
    expect(background.walletController.setBackgroundInited).not.toHaveBeenCalled();
    expect(browserStorage.set).not.toHaveBeenCalled();
  });

  it('reports another failure as failed, not as still starting, without blaming the stored settings', async () => {
    background.permissionService.init.mockRejectedValueOnce(new Error('permission store is malformed'));

    await startWorker();

    expect(background.walletController.setBackgroundStartupFailed).toHaveBeenCalledWith('unknown');
    expect(background.walletController.setBackgroundInited).not.toHaveBeenCalled();
  });
});
